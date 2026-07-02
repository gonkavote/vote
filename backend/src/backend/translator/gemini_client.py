"""Translate one batch via Google AI (Gemini) — key×model cascade.

Order: for each api_key in (key1, key2, key3), try each model in
(`gemma-4-31b-it`, `gemma-4-26b-a4b-it`). First successful response wins.
This matches the failover pattern in `primer/send.py`, narrowed to the two
models the user asked for.

Forces JSON output via `responseMimeType: application/json` so the worker
can parse the result with `json.loads()` without dealing with code fences.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

import httpx

from backend.settings import settings

logger = logging.getLogger(__name__)

MODELS = ["gemma-4-31b-it", "gemma-4-26b-a4b-it"]
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
REQUEST_TIMEOUT_S = 900  # Gemma 4 can think for ~10 min on long descriptions.


def _api_keys() -> list[str]:
    keys = [
        settings.gemini_api_key_1,
        settings.gemini_api_key_2,
        settings.gemini_api_key_3,
    ]
    return [k for k in keys if k]


def _payload(system_prompt: str, user_text: str) -> dict[str, Any]:
    return {
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }


def _extract_answer(data: dict[str, Any]) -> str:
    """Pull the final user-facing text out of a Gemini response.

    Gemma 4 sometimes returns two `parts`: a chain-of-thought block tagged
    `"thought": true`, followed by the actual answer. We want the answer —
    pick the last part that is *not* a thought, falling back to the very
    last part if every entry is tagged.
    """
    parts = data["candidates"][0]["content"]["parts"]
    for p in reversed(parts):
        if not p.get("thought") and p.get("text"):
            return p["text"].strip()
    return parts[-1].get("text", "").strip()


async def detect_lang_via_ai(text: str, supported: list[str]) -> Optional[str]:
    """Ask Gemma to label the language of `text`.

    To save tokens we feed only the first ~10 words; that's plenty for
    statistical disambiguation and avoids paying for thousands of tokens
    on long proposal descriptions.

    Returns a 2-letter code from `supported` or None if the cascade failed
    or the model picked a language we don't ship UI for.
    """
    snippet = " ".join((text or "").split()[:10]).strip()
    if not snippet:
        return None

    sys_prompt = (
        "You identify the language of a short user-written text snippet from a "
        "community forum. Reply with ONLY a JSON object: "
        "{\"lang\": \"<two-letter ISO 639-1 code>\"}. "
        f"Pick from this set: {supported}. If unsure, pick the closest. "
        "No commentary, no code fences."
    )
    user = json.dumps({"text": snippet}, ensure_ascii=False)
    try:
        result = await translate(sys_prompt, user)
    except RuntimeError as e:
        logger.warning("detect_lang_via_ai cascade failed: %s", e)
        return None
    code = str(result.get("lang", "")).strip().lower()[:2]
    if code in supported:
        return code
    logger.warning("detect_lang_via_ai returned unsupported lang %r", code)
    return None


async def translate(system_prompt: str, user_json: str) -> dict[str, Any]:
    """Send the prompt + JSON payload, return parsed dict.

    Raises RuntimeError if every (key × model) combination failed, or if the
    response can't be parsed as JSON.
    """
    keys = _api_keys()
    if not keys:
        raise RuntimeError("no GEMINI_API_KEY_* configured")

    payload = _payload(system_prompt, user_json)
    last_error: Optional[str] = None
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S) as cx:
        for key_idx, key in enumerate(keys, 1):
            for model in MODELS:
                url = ENDPOINT.format(model=model, key=key)
                try:
                    r = await cx.post(url, json=payload)
                    r.raise_for_status()
                    data = r.json()
                    text = _extract_answer(data)
                    parsed = json.loads(text)
                    logger.info("gemini ok: key#%d model=%s", key_idx, model)
                    return parsed
                except httpx.HTTPStatusError as e:
                    last_error = f"http {e.response.status_code} on key#{key_idx}/{model}: {e.response.text[:200]}"
                    logger.warning(last_error)
                    continue
                except (json.JSONDecodeError, KeyError, IndexError) as e:
                    last_error = f"parse error on key#{key_idx}/{model}: {e}"
                    logger.warning(last_error)
                    continue
                except httpx.HTTPError as e:
                    last_error = (
                        f"network error on key#{key_idx}/{model}: "
                        f"{type(e).__name__}: {e or '(no detail)'}"
                    )
                    logger.warning(last_error)
                    continue
    raise RuntimeError(f"all gemini key×model combos failed: {last_error or 'no detail'}")
