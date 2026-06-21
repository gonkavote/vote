"""Language detection helpers.

Primary path is the AI-based detector in `translator.gemini_client`
(`detect_lang_via_ai`) — it uses Gemma on the first 10 words of the text,
which gives correct answers on short, mixed-script comments where
statistical detectors trip up.

`detect_lang` here is a tiny `langdetect` wrapper kept as a sync, no-network
fallback for the one-shot backfill script. The HTTP path (router.py) doesn't
detect at all — INSERT leaves source_lang='' and the worker resolves it via
the AI detector before enqueueing per-language translations.
"""
from __future__ import annotations

import logging

from langdetect import DetectorFactory, LangDetectException, detect

from backend.settings import settings

DetectorFactory.seed = 0
logger = logging.getLogger(__name__)


def supported_languages() -> list[str]:
    """List of UI-supported language codes from settings (CSV)."""
    return [c.strip().lower() for c in settings.translation_languages.split(",") if c.strip()]


def detect_lang(text: str, default: str = "en") -> str:
    """Best-effort offline detection. Returns a code from `supported_languages()`
    or `default`. For better accuracy on short text, use the AI detector."""
    if not text or len(text.strip()) < 4:
        return default
    try:
        code = detect(text)[:2].lower()
    except LangDetectException as e:
        logger.debug("langdetect failed on text len=%d: %s", len(text), e)
        return default
    return code if code in supported_languages() else default
