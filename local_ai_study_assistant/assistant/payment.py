from __future__ import annotations

import json
import uuid
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from assistant.config import Settings


X402_PAYMENT_HEADERS = ("X-PAYMENT", "X-402-PAYMENT")
PAYMENT_DESCRIPTION = "Paid RAG answer from local_ai_study_assistant"


@dataclass(frozen=True)
class PaymentRequirement:
    scheme: str
    network: str
    asset: str
    amount: str
    recipient: str
    resource: str
    description: str


@dataclass(frozen=True)
class PaymentResult:
    ok: bool
    mode: str
    status: str
    payment_id: str | None = None
    payer: str | None = None
    error: str | None = None
    requirement: PaymentRequirement | None = None
    raw: dict[str, Any] | None = None


class PaymentVerifier(Protocol):
    def verify(self, headers: Any, request_body: dict[str, Any]) -> PaymentResult:
        ...


def build_payment_requirement(settings: Settings) -> PaymentRequirement:
    return PaymentRequirement(
        scheme="x402",
        network=settings.payment_network,
        asset=settings.payment_asset,
        amount=settings.payment_price,
        recipient=settings.payment_recipient,
        resource=settings.payment_resource,
        description=PAYMENT_DESCRIPTION,
    )


def payment_requirement_to_dict(requirement: PaymentRequirement) -> dict[str, str]:
    return {
        "scheme": requirement.scheme,
        "network": requirement.network,
        "asset": requirement.asset,
        "amount": requirement.amount,
        "recipient": requirement.recipient,
        "resource": requirement.resource,
        "description": requirement.description,
    }


def payment_result_to_public_dict(result: PaymentResult) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": result.ok,
        "mode": result.mode,
        "status": result.status,
    }
    optional_fields = {
        "payment_id": result.payment_id,
        "payer": result.payer,
        "error": result.error,
    }
    payload.update({key: value for key, value in optional_fields.items() if value})
    if result.requirement:
        payload["requirement"] = payment_requirement_to_dict(result.requirement)
    return payload


def create_payment_verifier(settings: Settings) -> PaymentVerifier:
    verifiers: dict[str, type[BasePaymentVerifier]] = {
        "off": NoopPaymentVerifier,
        "mock": MockPaymentVerifier,
        "x402": X402PaymentVerifier,
    }
    return verifiers.get(settings.payment_mode, NoopPaymentVerifier)(settings)


class BasePaymentVerifier:
    mode = "base"

    def __init__(self, settings: Settings):
        self.settings = settings

    def requirement(self) -> PaymentRequirement:
        return build_payment_requirement(self.settings)

    def failed(self, status: str, error: str) -> PaymentResult:
        return PaymentResult(
            ok=False,
            mode=self.mode,
            status=status,
            error=error,
            requirement=self.requirement(),
        )


class NoopPaymentVerifier(BasePaymentVerifier):
    mode = "off"

    def verify(self, headers: Any, request_body: dict[str, Any]) -> PaymentResult:
        return PaymentResult(
            ok=True,
            mode=self.mode,
            status="skipped",
            payment_id=f"off_{uuid.uuid4().hex[:12]}",
        )


class MockPaymentVerifier(BasePaymentVerifier):
    mode = "mock"

    def verify(self, headers: Any, request_body: dict[str, Any]) -> PaymentResult:
        body_payment = self.body_payment(request_body)
        token = str(headers.get("X-Mock-Payment", "")).strip() or str(body_payment.get("token", "")).strip()
        if token == self.settings.payment_mock_token:
            return PaymentResult(
                ok=True,
                mode=self.mode,
                status="paid",
                payment_id=f"mock_{uuid.uuid4().hex[:12]}",
                payer=str(body_payment.get("payer", "mock-agent") or "mock-agent"),
            )
        return self.failed("payment_required", "Missing or invalid mock payment token.")

    def body_payment(self, request_body: dict[str, Any]) -> dict[str, Any]:
        payment = request_body.get("payment")
        return payment if isinstance(payment, dict) else {}


class X402PaymentVerifier(BasePaymentVerifier):
    mode = "x402"

    def verify(self, headers: Any, request_body: dict[str, Any]) -> PaymentResult:
        payment_header = self.payment_header(headers)
        if not payment_header:
            return self.failed("payment_required", "Missing x402 payment header.")
        if not self.settings.x402_verify_url:
            return self.failed(
                "verifier_not_configured",
                "x402 payment verifier is not configured. Set LSA_X402_VERIFY_URL after confirming the GOAT/x402 verification endpoint.",
            )

        result = self.call_verifier(payment_header)
        if isinstance(result, PaymentResult):
            return result
        return self.result_from_verifier_payload(result)

    def payment_header(self, headers: Any) -> str:
        for name in X402_PAYMENT_HEADERS:
            value = str(headers.get(name, "")).strip()
            if value:
                return value
        return ""

    def call_verifier(self, payment_header: str) -> dict[str, Any] | PaymentResult:
        # This adapter is intentionally small: replace the verifier endpoint
        # contract here when the official GOAT/x402 Python SDK or HTTP API is
        # confirmed. The rest of the service only depends on PaymentResult.
        request = urllib.request.Request(
            self.settings.x402_verify_url,
            data=json.dumps(self.verifier_payload(payment_header), ensure_ascii=False).encode("utf-8"),
            headers=self.verifier_headers(),
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.settings.payment_timeout_seconds) as response:
                body = response.read().decode("utf-8", errors="replace")
                return json.loads(body) if body.strip() else {}
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            return self.failed("verification_failed", str(exc))

    def verifier_payload(self, payment_header: str) -> dict[str, str]:
        return {
            "payment": payment_header,
            "resource": self.settings.payment_resource,
            "network": self.settings.payment_network,
            "asset": self.settings.payment_asset,
            "amount": self.settings.payment_price,
            "recipient": self.settings.payment_recipient,
        }

    def verifier_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.settings.x402_api_key:
            headers["Authorization"] = f"Bearer {self.settings.x402_api_key}"
        return headers

    def result_from_verifier_payload(self, result: dict[str, Any]) -> PaymentResult:
        if result.get("ok") or result.get("paid") or result.get("valid"):
            return PaymentResult(
                ok=True,
                mode=self.mode,
                status="paid",
                payment_id=str(result.get("payment_id") or result.get("transaction") or result.get("tx_hash") or ""),
                payer=str(result.get("payer") or result.get("from") or ""),
                raw=result,
            )
        return PaymentResult(
            ok=False,
            mode=self.mode,
            status=str(result.get("status") or "payment_required"),
            error=str(result.get("error") or "x402 payment verification failed."),
            requirement=self.requirement(),
            raw=result,
        )
