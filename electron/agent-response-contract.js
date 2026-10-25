/** Kana-only guidance for text that will be read by the local TTS voice. */
export const JAPANESE_TTS_INSTRUCTIONS = `For the spoken "text_ja" field only, write entirely in Japanese script using hiragana and katakana only: do not use kanji, English, or other Latin-script words. The kana-only rule applies to words, not punctuation: punctuation and line breaks are required in the Japanese VO transcript too. Include the matching comma, full stop, question mark, or other boundary from each Chinese chunk in its Japanese partner, including the final punctuation. Never remove punctuation from text_ja because captions hide it; only the application removes punctuation for display. Render foreign terms or proper names in katakana, including names or words with uncertain or inconsistent TTS readings, even when the source writes them with kanji. For example, write 小光 as ヒカリ in "text_ja", never 小光. Keep this kana-only rule limited to the Japanese speech field; leave "text" in its requested language and writing system.`;

/**
 * Instructions to interpolate into the HTTP system prompt for bilingual
 * user-facing agent responses.
 */
export const BILINGUAL_RESPONSE_INSTRUCTIONS = `For every user-facing response, return both "text" and "text_ja" in the JSON response.
- "text" is the original response in Traditional Chinese, written in natural spoken Cantonese while preserving the agent's existing voice and tone.
- "text_ja" is a faithful, natural spoken Japanese translation of "text", with the same meaning and tone. Keep it between 1 and 500 characters after trimming.
- ${JAPANESE_TTS_INSTRUCTIONS}
- Do not put stage directions, ruby/furigana markup, or romanization in "text_ja". Do not claim to detect language automatically, and never copy the Chinese text into "text_ja" as a fallback.

CONSTRUCT THE RESPONSE IN THIS ORDER:
1. Write "segments" FIRST as an array of bilingual pairs. Draft one short Cantonese caption phrase, then translate only that phrase into one natural kana-only Japanese VO phrase before drafting the next pair. Aim for 6–12 visible Chinese caption characters per pair; preserve whole phrases and meaning. Keep each Japanese phrase short too. Never translate the complete reply independently.
MANDATORY SIMPLE GRAMMAR: each partner is uninterrupted words followed by exactly ONE final 。 or ？ or ！. No commas (， 、 ,), colons, semicolons, ellipses, internal sentence endings, or line breaks anywhere inside either partner. Omit conversational filler commas and use natural connected wording instead. If a thought needs another pause or sentence, make another bilingual pair. This rule applies to the contents of the segment fields, not JSON syntax or the newline joins in the full fields. Final emoji may follow the Chinese ending mark. For example, write "老師早晨！" / "せんせいおはよう！", never put "老師，早晨！" into one entry.
2. Each entry must have exactly one spoken phrase in "text" and exactly one in "text_ja". The application splits at every occurrence of these boundary characters: ， 、 , ； ; ： : 。 ！ ？ ! ? … . and every line break. An internal boundary followed by more words starts ANOTHER phrase. Split before adding such a boundary, or rephrase Japanese without the extra comma. Do not insert line breaks inside an entry. A decimal point or clock colon between digits is not a boundary.
3. Put one matching terminal punctuation mark at the end of BOTH partners. Keep punctuation boundaries synchronized with the same number and order of phrases; do not add or omit a boundary in either language. Use 。 with 。, ？ with ？, or ！ with ！. Keep any final emoji after the punctuation on the final Chinese entry; omit emoji from Japanese. Never create an emoji-only or punctuation-only entry.
4. COPY the completed pairs into the full fields: text = segments.map(pair => pair.text).join("\\n"); text_ja = segments.map(pair => pair.text_ja).join("\\n"). These fields must be exact copies joined by JSON-escaped line breaks, with no rewording, extra punctuation, or omissions. Line breaks separate pairs in these full fields only.
5. Before sending, silently check EVERY pair with the application's split rule from step 2: Chinese phrase count = 1 AND Japanese phrase count = 1. Equal array lengths alone are insufficient. If either count exceeds 1, split it into separate translated pairs or remove the internal boundary by natural rephrasing. Then check the full fields match the joined pairs and all Japanese text stays within 500 characters. Fix failures before returning the FIRST response; do not wait for a repair request.

INVALID pair: {"text":"老師，食飯未？","text_ja":"せんせい もうごはんはたべた？"}. Chinese has 2 phrases and Japanese has 1.
CORRECT pair: {"text":"老師食飯未？","text_ja":"せんせいもうごはんはたべた？"}.
INVALID pair: {"text":"我陪住你。","text_ja":"わたしが、そばにいるよ。"}. Japanese has an extra comma and therefore 2 phrases.
CORRECT pair: {"text":"我陪住你。","text_ja":"わたしがそばにいるよ。"}.

Example: {"segments":[{"text":"老師早晨！","text_ja":"せんせいおはよう！"},{"text":"今日點呀？😊","text_ja":"きょうはどう？"}],"text":"老師早晨！\\n今日點呀？😊","text_ja":"せんせいおはよう！\\nきょうはどう？"}`;

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
