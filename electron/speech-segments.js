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

export function prepareSpeechSegments(synthesize, text, speed = 1) {
  return splitSpeechSegments(text).map(segment => prepareSpeech(synthesize, segment, speed));
}
