# tools/handwriting/charset.py
# Shared character set + cell-naming helpers for the handwriting font pipeline.
#
# This file is a part of "Candle" application (hjLabs.in fork) tooling.
# Copyright 2026 hjLabs.in / Hemang Joshi
"""The ordered list of characters the pipeline asks the user to handwrite.

Order matters: the template lays cells out row-major in this order and the
spec file records the same order, so the vectorizer can map cell -> character.
"""

# Uppercase A-Z, lowercase a-z, digits 0-9, then space + punctuation.
UPPER = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
LOWER = [chr(c) for c in range(ord("a"), ord("z") + 1)]
DIGITS = [chr(c) for c in range(ord("0"), ord("9") + 1)]

# "space" is a real character (U+0020) but rendered as a labelled blank cell.
PUNCT = [".", ",", ":", ";", "!", "?", "-", "_", "(", ")", "/", "+", "=", "'", '"']

# Full ordered charset including space.
CHARSET = UPPER + LOWER + DIGITS + [" "] + PUNCT


def char_label(ch: str) -> str:
    """Human-readable label drawn in the cell for a character."""
    if ch == " ":
        return "space"
    return ch


def char_key(ch: str) -> str:
    """JSON object key for a character (single char, exactly as consumed by C++)."""
    return ch
