/** Kana-only guidance for text that will be read by the local TTS voice. */
export const JAPANESE_TTS_INSTRUCTIONS = `For the spoken "text_ja" field only, write entirely in Japanese script using hiragana and katakana only: do not use kanji, English, or other Latin-script words. The kana-only rule applies to words, not punctuation: punctuation and line breaks are required in the Japanese VO transcript too. Include the matching comma, full stop, question mark, or other boundary from each Chinese chunk in its Japanese partner, including the final punctuation. Never remove punctuation from text_ja because captions hide it; only the application removes punctuation for display. Render foreign terms or proper names in katakana, including names or words with uncertain or inconsistent TTS readings, even when the source writes them with kanji. For example, write 小光 as ヒカリ in "text_ja", never 小光. Keep this kana-only rule limited to the Japanese speech field; leave "text" in its requested language and writing system.`;

/**
 * Instructions to interpolate into the HTTP system prompt for bilingual
 * user-facing agent responses.
 */
export const BILINGUAL_RESPONSE_INSTRUCTIONS = `For every user-facing response, return both "text" and "text_ja" in the JSON response.
- "text" is the original response in Traditional Chinese, written in natural spoken Cantonese while preserving the agent's existing voice and tone.
- "text_ja" is a faithful, natural spoken Japanese translation of "text", with the same meaning and tone. Keep it between 1 and 500 characters after trimming.
- Format both fields as short, speakable message segments separated by line breaks. Playback and captions automatically split at line breaks and punctuation, including commas, enumeration commas, colons, semicolons, full stops, question marks, exclamation marks, and ellipses. Keep punctuation boundaries synchronized between "text" and the Japanese VO transcript "text_ja": use the same number and order of phrases, with corresponding punctuation and line breaks at the same thought boundaries. Language-appropriate punctuation glyphs may differ (for example ， and 、, or 。 and .), but do not add or omit a boundary in either field. Also split a long sentence into smaller segments so each is roughly 10–15 spoken words at most. Do not split in the middle of a phrase.
- ${JAPANESE_TTS_INSTRUCTIONS}
- Do not put stage directions, ruby/furigana markup, or romanization in "text_ja". Do not claim to detect language automatically, and never copy the Chinese text into "text_ja" as a fallback.
- Always include a "segments" array of paired chunks: [{"text":"中文短句，","text_ja":"にほんごのくぎり、"},{"text":"下一句。😊","text_ja":"つぎのくぎり。"}]. Each pair is one caption and its corresponding Japanese VO phrase, in the same order and with the same meaning. Split pairs at punctuation or line breaks. Build these pairs first, then set the top-level "text" and "text_ja" to their respective chunks joined by line breaks. Verify every Chinese chunk has exactly one Japanese partner before sending. Do not translate the two complete fields independently. Each segments entry must contain exactly one punctuation-delimited phrase per language: no internal commas, sentence endings, or line breaks followed by more words. Put each boundary at the end of its own pair (before a trailing emoji). Translate the Chinese phrases individually in order; rephrase Japanese naturally within each phrase rather than adding extra punctuation boundaries. Keep any trailing emoji on the final Chinese chunk, never in a separate chunk; omit emoji from the Japanese VO transcript.

Example: {"text":"繁體中文的廣東話回覆。\\n第二段短一點。😊","text_ja":"しぜんなにほんごのへんじ。\\nつぎのぶんもみじかく。","segments":[{"text":"繁體中文的廣東話回覆。","text_ja":"しぜんなにほんごのへんじ。"},{"text":"第二段短一點。😊","text_ja":"つぎのぶんもみじかく。"}]}`;

/**
 * Normalize an optional Japanese response for display. Missing or null values
 * become an empty string so legacy responses can remain silent in Japanese
 * until the parent display layer chooses its fallback behavior.
 */
export function normalizeJapaneseText(value) {
  if (typeof value !== 'string') return '';

  const normalized = value
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  if (!normalized || Array.from(normalized).length > 500) return '';
  return normalized;
}
