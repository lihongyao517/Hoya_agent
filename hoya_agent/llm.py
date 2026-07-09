from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterator


@dataclass
class LLMClient:
    api_key: str
    base_url: str
    model: str
    wire_api: str = "chat"
    temperature: float = 0.2
    timeout: int = 90

    def endpoint_url(self) -> str:
        if self.wire_api == "responses":
            if self.base_url.endswith("/responses"):
                return self.base_url
            if self.base_url.endswith("/v1"):
                return f"{self.base_url}/responses"
            return f"{self.base_url}/v1/responses"
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        if not self.base_url.endswith("/v1"):
            return f"{self.base_url}/v1/chat/completions"
        return f"{self.base_url}/chat/completions"

    def _payload(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], stream: bool) -> dict[str, Any]:
        if self.wire_api == "responses":
            return self._responses_payload(messages, tools, stream)

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "stream": stream,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        return payload

    def _responses_payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        stream: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "input": self._responses_input(messages),
            "stream": stream,
        }
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        if tools:
            payload["tools"] = [self._responses_tool(tool) for tool in tools]
            payload["tool_choice"] = "auto"
        return payload

    def _responses_input(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for message in messages:
            role = message.get("role")
            if role == "tool":
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": message.get("tool_call_id") or message.get("name") or "tool_call",
                        "output": message.get("content") or "",
                    }
                )
                continue

            content = message.get("content")
            if content:
                items.append({"role": role or "user", "content": content})

            for tool_call in message.get("tool_calls") or []:
                function = tool_call.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": tool_call.get("id") or function.get("name") or "tool_call",
                        "name": function.get("name", ""),
                        "arguments": function.get("arguments", "{}"),
                    }
                )
        return items

    def _responses_tool(self, tool: dict[str, Any]) -> dict[str, Any]:
        function = tool.get("function") or {}
        return {
            "type": "function",
            "name": function.get("name", ""),
            "description": function.get("description", ""),
            "parameters": function.get("parameters", {"type": "object", "properties": {}}),
        }

    def _request(self, payload: dict[str, Any]) -> urllib.request.Request:
        return urllib.request.Request(
            url=self.endpoint_url(),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

    def _non_json_error(self, body: str) -> RuntimeError:
        preview = body[:500]
        html_hint = ""
        if "<!doctype html" in body.lower() or "<html" in body.lower():
            html_hint = (
                "\nThe relay returned an HTML page, which usually means HOYA_BASE_URL is "
                "a website URL instead of an API endpoint. Use something like "
                "https://your-relay.example.com/v1 or the full chat completions URL."
            )
        return RuntimeError(
            "LLM request returned non-JSON content. Check HOYA_BASE_URL and relay settings.\n"
            f"Requested URL: {self.endpoint_url()}"
            f"{html_hint}\n"
            f"Response preview:\n{preview}"
        )

    def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        payload = self._payload(messages, tools, stream=False)
        request = urllib.request.Request(
            url=self.endpoint_url(),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
                if not body.strip():
                    raise RuntimeError(
                        "LLM request returned an empty response. Check HOYA_BASE_URL, HOYA_MODEL, "
                        "and whether your relay supports the configured wire API."
                    )
                try:
                    data = json.loads(body)
                    if self.wire_api == "responses":
                        return self._normalize_responses_response(data)
                    if "error" in data:
                        raise RuntimeError(f"LLM request returned an error: {data['error']}")
                    choices = data.get("choices")
                    if not isinstance(choices, list) or not choices:
                        raise RuntimeError(
                            "LLM response did not contain choices. Check whether the relay is compatible "
                            "with OpenAI Chat Completions or set HOYA_WIRE_API=responses if needed."
                        )
                    return data
                except json.JSONDecodeError as exc:
                    raise self._non_json_error(body) from exc
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM request failed: HTTP {exc.code}\n{body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"LLM request failed: {exc.reason}") from exc

    def chat_stream(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        payload = self._payload(messages, tools, stream=True)
        request = self._request(payload)

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                content_type = response.headers.get("Content-Type", "")
                if "text/html" in content_type.lower():
                    body = response.read().decode("utf-8", errors="replace")
                    raise self._non_json_error(body)

                if "application/json" in content_type.lower():
                    body = response.read().decode("utf-8", errors="replace")
                    try:
                        data = json.loads(body)
                    except json.JSONDecodeError as exc:
                        raise self._non_json_error(body) from exc
                    if self.wire_api == "responses":
                        yield from self._normalize_responses_json_as_stream(data)
                        return
                    choices = data.get("choices")
                    if not isinstance(choices, list) or not choices:
                        yield {"choices": []}
                        return
                    first_choice = choices[0] if isinstance(choices[0], dict) else {}
                    message = first_choice.get("message") or {}
                    delta: dict[str, Any] = {}
                    if message.get("content"):
                        delta["content"] = message["content"]
                    if message.get("tool_calls"):
                        delta["tool_calls"] = message["tool_calls"]
                    yield {"choices": [{"delta": delta}]}
                    return

                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        break
                    try:
                        data = json.loads(line)
                        if self.wire_api == "responses":
                            normalized = self._normalize_responses_stream_event(data)
                            if normalized is not None:
                                yield normalized
                        else:
                            yield data
                    except json.JSONDecodeError as exc:
                        raise self._non_json_error(line) from exc
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM request failed: HTTP {exc.code}\n{body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"LLM request failed: {exc.reason}") from exc

    def _normalize_responses_response(self, data: dict[str, Any]) -> dict[str, Any]:
        content_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for item in data.get("output") or []:
            item_type = item.get("type")
            if item_type == "message":
                for part in item.get("content") or []:
                    if part.get("type") in {"output_text", "text"} and part.get("text"):
                        content_parts.append(part["text"])
            elif item_type == "function_call":
                tool_calls.append(
                    {
                        "id": item.get("call_id") or item.get("id") or item.get("name", "tool_call"),
                        "type": "function",
                        "function": {
                            "name": item.get("name", ""),
                            "arguments": item.get("arguments", "{}"),
                        },
                    }
                )

        message: dict[str, Any] = {"role": "assistant", "content": "".join(content_parts)}
        if tool_calls:
            message["tool_calls"] = tool_calls
        return {"choices": [{"message": message}]}

    def _normalize_responses_json_as_stream(self, data: dict[str, Any]) -> Iterator[dict[str, Any]]:
        normalized = self._normalize_responses_response(data)
        message = normalized.get("choices", [{}])[0].get("message") or {}
        delta: dict[str, Any] = {}
        if message.get("content"):
            delta["content"] = message["content"]
        if message.get("tool_calls"):
            delta["tool_calls"] = message["tool_calls"]
        yield {"choices": [{"delta": delta}]}

    def _normalize_responses_stream_event(self, event: dict[str, Any]) -> dict[str, Any] | None:
        event_type = event.get("type")
        if event_type == "response.output_text.delta":
            delta = event.get("delta")
            if delta:
                return {"choices": [{"delta": {"content": delta}}]}
            return None

        if event_type == "response.output_item.done":
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                return {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": int(event.get("output_index", 0)),
                                        "id": item.get("call_id") or item.get("id") or item.get("name", "tool_call"),
                                        "type": "function",
                                        "function": {
                                            "name": item.get("name", ""),
                                            "arguments": item.get("arguments", "{}"),
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                }
            return None

        if event_type == "response.completed":
            return {"choices": []}
        if event_type and event_type.startswith("response."):
            return None
        return None
