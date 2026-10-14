/**
 * One normaliser for every comparison Hearth makes on Hindi text: the quote gate, the field gate, the
 * number/weekday tables and search. Both sides of any comparison go through it, and every lookup table is
 * built through it too, so a spelling variant can never make a table miss.
 *
 * Order matters (each step assumes the previous one):
 *  1. NFC. Note U+0958–U+095F (क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़) are composition exclusions: NFC leaves them DECOMPOSED as
 *     consonant + U+093C, which is what lets step 2 remove the nukta from both spellings alike.
 *  2. Delete U+093C nukta (हज़ार and हजार compare equal).
 *  3. Map U+0901 chandrabindu to U+0902 anusvara (पाँच and पांच compare equal).
 *  4. Strip ZWJ / ZWNJ.
 *  5. Join digit groups ("5,000" -> "5000") and drop the rupee sign, before punctuation becomes a space.
 *  6. Danda, double danda and punctuation become spaces; Latin is lower-cased; whitespace collapses.
 */

const PUNCT = /[।॥.,!?;:"'()[\]{}<>«»“”‘’…\-–—/\\|*_#@%&+=~`^]/g;

export function normalizeHi(text: string): string {
  return text
    .normalize("NFC")
    .replace(/़/g, "")
    .replace(/ँ/g, "ं")
    .replace(/[‌‍]/g, "")
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/₹/g, " ")
    .replace(PUNCT, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Devanagari digits to ASCII (after normalisation, so "५,०००" and "5000" compare equal). */
export function asciiDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

export function tokens(text: string): string[] {
  const n = asciiDigits(normalizeHi(text));
  return n ? n.split(" ") : [];
}

/** True when `needle` occurs in `hay` on whole-token boundaries (both already normalised). */
export function containsTokens(hay: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${hay} `.includes(` ${needle} `);
}
