from __future__ import annotations

import http.client
import json
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterator


@dataclass
class LLMClient:
    api_key: str
    base_url: str
    model: str
    provider: str = "openai-compatible"
    wire_api: str = "chat"
    reasoning_effort: str = "medium"
    temperature: float = 0.2
    timeout: int = 90

    def endpoint_url(self) -> str:
        if self.provider == "anthropic":
            if self.base_url.endswith("/messages"):
                return self.base_url
            if self.base_url.endswith("/v1"):
                return f"{self.base_url}/messages"
            return f"{self.base_url}/v1/messages"
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
        if self.provider == "anthropic":
            return self._anthropic_payload(messages, tools, stream)
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

    def _anthropic_payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        stream: bool,
    ) -> dict[str, Any]:
        system_parts: list[str] = []
        converted: list[dict[str, Any]] = []
        tool_results: list[dict[str, Any]] = []

        def flush_tool_results() -> None:
            if tool_results:
                converted.append({"role": "user", "content": list(tool_results)})
                tool_results.clear()

        for message in messages:
            role = str(message.get("role") or "user")
            content = message.get("content")
            if role == "system":
                if content:
                    system_parts.append(str(content))
                continue
            if role == "tool":
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": message.get("tool_call_id") or message.get("name") or "tool_call",
                        "content": str(content or ""),
                    }
                )
                continue

            flush_tool_results()
            if role == "assistant":
                blocks: list[dict[str, Any]] = []
                if content:
                    blocks.append({"type": "text", "text": str(content)})
                for tool_call in message.get("tool_calls") or []:
                    function = tool_call.get("function") or {}
                    raw_arguments = function.get("arguments") or "{}"
                    try:
                        arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
                    except json.JSONDecodeError:
                        arguments = {}
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": tool_call.get("id") or function.get("name") or "tool_call",
                            "name": function.get("name", ""),
                            "input": arguments if isinstance(arguments, dict) else {},
                        }
                    )
                converted.append({"role": "assistant", "content": blocks or ""})
            else:
                converted.append({"role": "user", "content": str(content or "")})

        flush_tool_results()
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 8192,
            "messages": converted,
            "stream": stream,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        if tools:
            payload["tools"] = [self._anthropic_tool(tool) for tool in tools]
            payload["tool_choice"] = {"type": "auto"}
        return payload

    def _anthropic_tool(self, tool: dict[str, Any]) -> dict[str, Any]:
        function = tool.get("function") or {}
        return {
            "name": function.get("name", ""),
            "description": function.get("description", ""),
            "input_schema": function.get("parameters", {"type": "object", "properties": {}}),
        }

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
        effort_map = {
            "minimal": "low",
            "standard": "medium",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "high",
            "max": "high",
        }
        payload["reasoning"] = {"effort": effort_map.get(self.reasoning_effort, "medium")}
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

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key and self.provider == "anthropic":
            headers["x-api-key"] = self.api_key
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["anthropic-version"] = "2023-06-01"
        elif self.api_key and self.provider != "ollama":
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, payload: dict[str, Any]) -> urllib.request.Request:
        return urllib.request.Request(
            url=self.endpoint_url(),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=self._headers(),
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
            headers=self._headers(),
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
                    if self.provider == "anthropic":
                        return self._normalize_anthropic_response(data)
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

    def chat_stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        cancel_event: threading.Event | None = None,
    ) -> Iterator[dict[str, Any]]:
        if cancel_event is not None and cancel_event.is_set():
            return
        payload = self._payload(messages, tools, stream=True)
        request = self._request(payload)

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                stream_finished = threading.Event()
                if cancel_event is not None:
                    threading.Thread(
                        target=self._close_response_on_cancel,
                        args=(response, cancel_event, stream_finished),
                        daemon=True,
                    ).start()
                try:
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
                        if self.provider == "anthropic":
                            yield from self._normalize_anthropic_json_as_stream(data)
                            return
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
                        if cancel_event is not None and cancel_event.is_set():
                            return
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if not line or line.startswith(":") or line.startswith("event:"):
                            continue
                        if line.startswith("data:"):
                            line = line[5:].strip()
                        if line == "[DONE]":
                            break
                        try:
                            data = json.loads(line)
                            if self.provider == "anthropic":
                                normalized = self._normalize_anthropic_stream_event(data)
                                if normalized is not None:
                                    yield normalized
                            elif self.wire_api == "responses":
                                normalized = self._normalize_responses_stream_event(data)
                                if normalized is not None:
                                    yield normalized
                            else:
                                yield data
                        except json.JSONDecodeError as exc:
                            raise self._non_json_error(line) from exc
                finally:
                    stream_finished.set()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM request failed: HTTP {exc.code}\n{body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"LLM request failed: {exc.reason}") from exc
        except (OSError, ValueError, http.client.IncompleteRead) as exc:
            if cancel_event is not None and cancel_event.is_set():
                return
            raise RuntimeError(f"LLM response stream failed: {exc}") from exc

    @staticmethod
    def _close_response_on_cancel(
        response: Any,
        cancel_event: threading.Event,
        stream_finished: threading.Event,
    ) -> None:
        while not stream_finished.wait(0.1):
            if cancel_event.is_set():
                response.close()
                return

    def _normalize_anthropic_response(self, data: dict[str, Any]) -> dict[str, Any]:
        if data.get("type") == "error" or data.get("error"):
            raise RuntimeError(f"Anthropic request returned an error: {data.get('error') or data}")

        content_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for block in data.get("content") or []:
            block_type = block.get("type")
            if block_type == "text" and block.get("text"):
                content_parts.append(str(block["text"]))
            elif block_type == "tool_use":
                tool_calls.append(
                    {
                        "id": block.get("id") or block.get("name") or "tool_call",
                        "type": "function",
                        "function": {
                            "name": block.get("name", ""),
                            "arguments": json.dumps(block.get("input") or {}, ensure_ascii=False),
                        },
                    }
                )

        message: dict[str, Any] = {"role": "assistant", "content": "".join(content_parts)}
        if tool_calls:
            message["tool_calls"] = tool_calls
        return {"choices": [{"message": message}]}

    def _normalize_anthropic_json_as_stream(self, data: dict[str, Any]) -> Iterator[dict[str, Any]]:
        normalized = self._normalize_anthropic_response(data)
        message = normalized.get("choices", [{}])[0].get("message") or {}
        delta: dict[str, Any] = {}
        if message.get("content"):
            delta["content"] = message["content"]
        if message.get("tool_calls"):
            delta["tool_calls"] = [
                {"index": index, **tool_call}
                for index, tool_call in enumerate(message["tool_calls"])
            ]
        yield {"choices": [{"delta": delta}]}

    def _normalize_anthropic_stream_event(self, event: dict[str, Any]) -> dict[str, Any] | None:
        event_type = event.get("type")
        if event_type == "error":
            raise RuntimeError(f"Anthropic response stream failed: {event.get('error') or event}")

        if event_type == "content_block_start":
            block = event.get("content_block") or {}
            if block.get("type") == "tool_use":
                return {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": int(event.get("index", 0)),
                                        "id": block.get("id") or block.get("name") or "tool_call",
                                        "type": "function",
                                        "function": {"name": block.get("name", ""), "arguments": ""},
                                    }
                                ]
                            }
                        }
                    ]
                }
            if block.get("type") == "text" and block.get("text"):
                return {"choices": [{"delta": {"content": block["text"]}}]}
            return None

        if event_type == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                return {"choices": [{"delta": {"content": delta["text"]}}]}
            if delta.get("type") == "input_json_delta" and delta.get("partial_json") is not None:
                return {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": int(event.get("index", 0)),
                                        "function": {"arguments": str(delta.get("partial_json", ""))},
                                    }
                                ]
                            }
                        }
                    ]
                }
            return None

        if event_type in {
            "message_start",
            "message_delta",
            "message_stop",
            "content_block_stop",
            "ping",
        }:
            return None
        return None

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
