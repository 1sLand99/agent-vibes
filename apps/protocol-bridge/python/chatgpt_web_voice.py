#!/usr/bin/env python3
"""curl_cffi transport for the ChatGPT Web Voice SDP handshake."""

from __future__ import annotations

import json
import sys
import uuid

from curl_cffi import requests


def encode_multipart(fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = "----WebKitFormBoundary" + uuid.uuid4().hex[:16]
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n'
                "\r\n"
                f"{value}\r\n"
            ).encode("utf-8")
        )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def main() -> None:
    payload = json.load(sys.stdin)
    body, content_type = encode_multipart(
        {"sdp": payload["offer_sdp"], "session": payload["session_json"]}
    )
    headers = {
        str(key): str(value) for key, value in dict(payload.get("headers") or {}).items()
    }
    headers["content-type"] = content_type
    proxy_url = str(payload.get("proxy_url") or "").strip()
    session_options: dict[str, object] = {
        "impersonate": str(payload.get("impersonate") or "chrome136"),
        "verify": bool(payload.get("verify_ssl", True)),
        "timeout": int(payload.get("timeout_seconds") or 20),
    }
    if proxy_url:
        session_options["proxies"] = {"http": proxy_url, "https": proxy_url}
    session = requests.Session(**session_options)
    try:
        response = session.post(
            str(payload["endpoint"]),
            data=body,
            headers=headers,
            timeout=int(payload.get("timeout_seconds") or 20),
        )
        print(
            json.dumps(
                {
                    "status": int(response.status_code or 0),
                    "content_type": str(response.headers.get("content-type") or ""),
                    "text": response.text or "",
                },
                separators=(",", ":"),
            )
        )
    finally:
        session.close()


if __name__ == "__main__":
    main()
