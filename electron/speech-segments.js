import { prepareSpeech } from '../shared/speech-preparation.js';

export { cancelSpeechPreparations } from '../shared/speech-preparation.js';

const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const isEmoji = text => /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(text);
const isEmojiOnly = text => {
  const units = [...graphemes.segment(text.trim())].map(item => item.segment).filter(unit => unit.trim());
  return units.length > 0 && units.every(isEmoji);
};

/** Display punctuation is separate from the punctuation retained for TTS. */
export function formatCaption(text) {
  return [...graphemes.segment(String(text ?? ''))]
    .map(({ segment }) => isEmoji(segment) || segment === '—' ? segment : segment.replace(/\p{P}/gu, ''))
    .join('')
    .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '')
    .replace(/\s+(?=\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3)/gu, '')
    .trim();
}

function appendSegment(segments, text) {
  if (!formatCaption(text)) {
    if (segments.length) segments[segments.length - 1] += text.trim();
    return;
  }
  if (isEmojiOnly(text) && segments.length) segments[segments.length - 1] += text.trim();
  else segments.push(text);
}

/** Strip a history chunk's trailing punctuation while preserving quotes and emoji. */
export function formatHistoryChunk(text) {
  const units = [...graphemes.segment(String(text ?? '').trim())].map(item => item.segment);
  let emojiTail = '';
  while (units.length && (isEmoji(units.at(-1)) || !units.at(-1).trim())) {
    emojiTail = units.pop() + emojiTail;
  }
  return units.join('').trimEnd()
    .replace(/[，、,；;：:。！？!?….．]+([」』”’"')）】〕]*)$/u, '$1')
    .trimEnd() + emojiTail.trim();
}

/** Keep punctuation and closing quotes with the phrase that will be spoken. */
export function splitSpeechSegments(text) {
  const lines = String(text ?? '')
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .split(/\r\n?|\n/);
  const segments = [];
  for (const line of lines) {
    let start = 0;
    for (const match of line.matchAll(/[，、,；;：:。！？!?….]+[」』”’"')）】〕]*/gu)) {
      // Decimal numbers and clock times are not phrase boundaries.
      if (/^[.:]$/.test(match[0]) && /\d/.test(line[match.index - 1] ?? '')
          && /\d/.test(line[match.index + 1] ?? '')) continue;
      const end = match.index + match[0].length;
      const segment = line.slice(start, end).trim();
      if (segment) appendSegment(segments, segment);
      start = end;
    }
    const tail = line.slice(start).trim();
    if (tail) appendSegment(segments, tail);
  }
  return segments;
}

/** Explicit bilingual pairs are authoritative; punctuation is a legacy fallback. */
export function normalizePairedSegments(value, { requireAlignment = false } = {}) {
  if (!Array.isArray(value) || !value.length) return null;
  const pairs = [];
  for (const item of value) {
    if (typeof item?.text !== 'string' || typeof item?.text_ja !== 'string') return null;
    const text = item.text.trim();
    const text_ja = item.text_ja.trim();
    if (isEmojiOnly(text) && pairs.length && (!text_ja || isEmojiOnly(text_ja))) {
      pairs[pairs.length - 1].text += text;
      continue;
    }
    if (!text || !text_ja) return null;
    const captions = splitSpeechSegments(text);
    const speech = splitSpeechSegments(text_ja);
    if (!captions.length || !speech.length) return null;
    if (captions.length !== speech.length) {
      if (requireAlignment) return null;
      // The explicit translation pair is still usable as one caption/audio
      // unit when the agent could not repair its internal punctuation.
      pairs.push({ text, text_ja });
      continue;
    }
    pairs.push(...captions.map((caption, index) => ({ text: caption, text_ja: speech[index] })));
  }
  if (!pairs.length || Array.from(pairs.map(item => item.text_ja).join('\n')).length > 500) return null;
  return pairs;
}

export function getReplySegments(text, japaneseText, segments) {
  const paired = normalizePairedSegments(segments);
  if (paired) return paired;
  const captions = splitSpeechSegments(text);
  const speech = splitSpeechSegments(japaneseText);
  if (captions.length === speech.length) {
    return speech.map((text_ja, index) => ({ text: captions[index], text_ja }));
  }
  // Uncorrected legacy translations remain one pair, rather than repeating
  // the whole caption with every unrelated Japanese phrase.
  return japaneseText ? [{ text, text_ja: japaneseText }] : [];
}

export function prepareReplySpeech(synthesize, text, japaneseText, segments, speed = 1) {
  return getReplySegments(text, japaneseText, segments)
    .map(item => prepareSpeech(synthesize, item.text_ja, speed));
}

export function replyNeedsAlignmentRepair(reply) {
  let command;
  try { command = JSON.parse(reply); } catch { return false; }
  if (command.reply === false || command.react === false || command.speak === false) return false;
  if (command.segments !== undefined) return !normalizePairedSegments(command.segments, { requireAlignment: true });
  if (!command.text || !command.text_ja) return false;
  return splitSpeechSegments(command.text).length !== splitSpeechSegments(command.text_ja).length;
}

/** Prepare the same units that playback and captions consume. */
export function prepareSpeechSegments(synthesize, text, speed = 1) {
  return splitSpeechSegments(text).map(segment => prepareSpeech(synthesize, segment, speed));
}

/** Give the agent the actual boundaries that failed, rather than a generic retry. */
export function buildAlignmentRepairPrompt(reply) {
  const command = JSON.parse(reply);
  const source = Array.isArray(command.segments) && command.segments.length
    ? command.segments : [{ text: command.text, text_ja: command.text_ja }];
  const diagnostics = source.map((pair, index) => ({
    pair: index + 1,
    chineseChunks: splitSpeechSegments(pair?.text),
    japaneseChunks: splitSpeechSegments(pair?.text_ja),
  })).map(item => ({ ...item, chineseCount: item.chineseChunks.length, japaneseCount: item.japaneseChunks.length }));
  return `Repair only the response formatting and bilingual chunk alignment of your previous reply. Preserve its meaning, animation, expression, and reaction decision.
The application's actual punctuation split is: ${JSON.stringify(diagnostics)}
Use chineseChunks above as the ordered caption phrases. Translate each phrase individually into one natural Japanese VO phrase with the same meaning. Return one segments entry per Chinese phrase, each with exactly one text and one text_ja phrase. Do not return a whole multi-phrase reply as one entry. Do not insert internal commas, sentence endings, or line breaks followed by more words in either entry; rephrase Japanese to avoid extra boundaries. Put matching punctuation at the end of each pair, before any trailing emoji.
Include synchronized punctuation in the Japanese VO transcript text_ja too, both inside segments and in the top-level field. Kana-only applies to words, not punctuation. Captions hide punctuation only during display. Build the pairs first, then join each language with line breaks for text and text_ja. Keep trailing emoji on the last Chinese chunk; omit emoji from Japanese. Return the same JSON protocol, JSON only.`;
}
