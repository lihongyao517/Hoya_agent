from __future__ import annotations

import json
import urllib.error
import urllib.request

from assistant.config import Settings


class LLMClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def enabled(self) -> bool:
        return bool(self.settings.api_key)

    def chat(self, messages: list[dict[str, str]], temperature: float = 0.2) -> str:
        if not self.enabled:
            raise RuntimeError("未配置 LSA_API_KEY，无法调用大模型")

        url = self.settings.base_url.rstrip("/") + "/chat/completions"
        payload = {
            "model": self.settings.model,
            "messages": messages,
            "temperature": temperature,
        }
        request = urllib.request.Request(
            url=url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.settings.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"大模型接口返回错误：{exc.code} {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"大模型接口连接失败：{exc.reason}") from exc

        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError) as exc:
            raise RuntimeError("大模型响应格式不符合 Chat Completions 规范") from exc
