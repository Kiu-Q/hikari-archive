/**
 * Instructions to interpolate into the HTTP system prompt for bilingual
 * user-facing agent responses.
 */
export const BILINGUAL_RESPONSE_INSTRUCTIONS = `For every user-facing response, return both "text" and "text_ja" in the JSON response.
- "text" is the original response in Traditional Chinese, written in natural spoken Cantonese and Hikari's established personality.
- "text_ja" is a faithful, natural spoken Japanese translation of "text", with the same meaning and tone. Keep it between 1 and 500 characters after trimming.
- Do not put stage directions, ruby/furigana markup, or romanization in "text_ja". Do not claim to detect language automatically, and never copy the Chinese text into "text_ja" as a fallback.

Example: {"text":"繁體中文的廣東話回覆。","text_ja":"自然な日本語の返答。"}`;

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
