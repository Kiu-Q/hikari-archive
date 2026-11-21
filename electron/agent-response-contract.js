/** Guidance for dialogue read by the local Japanese TTS voice. */
export const JAPANESE_TTS_INSTRUCTIONS = 'The local Japanese TTS voice reads "text". Use hiragana and katakana for reliable pronunciation, and write foreign terms or proper names in katakana. For example, write 小光 as ヒカリ, and use ノゾミ, キヴォトス, and シュッチョウシュコウ. Keep natural punctuation. Internal line breaks are unnecessary.';

export const RESPONSE_INSTRUCTIONS = `Reply with one raw JSON object using double quotes, with no markdown code fences or extra text.
Format: {"text": "<Japanese dialogue>", "animation": {"file": "<exact filename>", "timing": "during"|"after"} | null, "expression": {"name": "<name>"} | null}
"text" is the complete reply in natural spoken Japanese, between 1 and 500 characters after trimming. It may contain several sentences.
${JAPANESE_TTS_INSTRUCTIONS}`;

/** Normalize and validate Japanese dialogue for display and speech. */
export function normalizeJapaneseText(value) {
  if (typeof value !== 'string') return '';

  const normalized = value
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  if (!/[^\x00-\x7F]/.test(normalized) || Array.from(normalized).length > 500) return '';
  return normalized;
}
