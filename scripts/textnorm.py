"""The Devanagari normaliser used for every WER Hearth publishes — the same steps, in the same order, as the
app's quote-gate normaliser (src/lib/hindi/normalize.ts): NFC; delete the nukta U+093C; chandrabindu U+0901
-> anusvara U+0902; strip ZWJ/ZWNJ; join digit groups; punctuation and danda -> space; lower-case Latin;
collapse whitespace. "Strict" skips the nukta and chandrabindu folds and is always reported beside it.
"""
from __future__ import annotations

import re
import unicodedata

PUNCT = re.compile(r"[।॥.,!?;:\"'()\[\]{}<>«»“”‘’…\-–—/\\|*_#@%&+=~`^₹]")
TAG = re.compile(r"<[a-z]{2,3}-[A-Z]{2}>")


def normalize(text: str, fold: bool = True) -> str:
    t = unicodedata.normalize("NFC", TAG.sub(" ", text))
    if fold:
        t = t.replace("़", "").replace("ँ", "ं")
    t = t.replace("‌", "").replace("‍", "")
    t = re.sub(r"(\d),(?=\d)", r"\1", t)
    t = PUNCT.sub(" ", t).lower()
    return re.sub(r"\s+", " ", t).strip()


def words(text: str, fold: bool = True) -> list[str]:
    n = normalize(text, fold)
    return n.split(" ") if n else []
