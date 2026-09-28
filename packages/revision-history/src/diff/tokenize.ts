/**
 * Word-level tokenisation for inline diffing.
 *
 * `diffWordsWithSpace`-style tokenisers split on whitespace and Latin word
 * boundaries, which leaves an entire Chinese run as one token — changing one
 * character would then mark the whole paragraph. Chinese is this editor's
 * primary content language, so the boundary set has to cover scripts that do not
 * separate words with spaces.
 *
 * `Intl.Segmenter` supplies those boundaries: it is ICU-backed, native in every
 * browser this editor targets, and needs no dependency, which matters because
 * this package ships with no production dependencies. CJK segments are split
 * into code points below so a partial word at an edit boundary cannot be forced
 * to align as an insertion or deletion solely because ICU chose a word boundary.
 */

/**
 * Locale-independent segmentation.
 *
 * Word boundaries are a property of the text, not of the reader — a document
 * mixing Chinese and English must tokenise the same way for everyone, otherwise
 * two people comparing the same revisions would see different change counts.
 */
const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null

/**
 * Fallback boundaries for runtimes without `Intl.Segmenter`.
 *
 * Splits runs of CJK into single characters and keeps other runs whole, which is
 * coarser than ICU inside CJK but never worse than diffing whole paragraphs.
 *
 * Script property escapes rather than literal code-point ranges: an earlier
 * version spelled the CJK Compatibility Ideographs boundary as a literal U+F900,
 * which NFC-normalises to U+8C48. That silently widened the class by ~29,000 code
 * points, so Hangul syllables fell into the CJK branch and Korean was split per
 * character. The trap renews itself every time the literal is retyped;
 * `\p{Script=...}` cannot be damaged by normalising this file, and it names what
 * it matches.
 */
const FALLBACK_SCRIPTS = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}`
const FALLBACK_PATTERN = new RegExp(
  `[${FALLBACK_SCRIPTS}]|[^${FALLBACK_SCRIPTS}]+`,
  'gu'
)
const CJK_SEGMENT_PATTERN = new RegExp(`[${FALLBACK_SCRIPTS}]`, 'u')

/**
 * The fallback tokeniser, exported so it can be tested directly.
 *
 * {@link segmenter} is resolved once at module load, so {@link tokenize} can
 * never reach this branch in an environment that has `Intl.Segmenter` — which
 * includes the test runner. Calling it directly is the only way to cover it
 * without mocking the module.
 */
export function fallbackTokens(text: string): string[] {
  return text.match(FALLBACK_PATTERN) ?? []
}

/**
 * Splits text into diffable tokens.
 *
 * Whitespace is kept as its own token rather than dropped: the tokens are
 * rejoined into document positions, so losing one would shift every position
 * after it.
 */
export function tokenize(text: string): readonly string[] {
  if (text === '') {
    return []
  }
  if (segmenter === null) {
    return fallbackTokens(text)
  }
  const tokens: string[] = []
  for (const { segment } of segmenter.segment(text)) {
    if (CJK_SEGMENT_PATTERN.test(segment)) {
      tokens.push(...fallbackTokens(segment))
    } else {
      tokens.push(segment)
    }
  }
  return tokens
}
