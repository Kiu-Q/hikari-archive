const MAX_DATA_URL_LENGTH = Math.ceil(2 * 1024 * 1024 / 3) * 4 + 23;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
export const SCREENSHOT_DEFAULT_PROMPT = '請睇吓呢張螢幕截圖，簡短講吓你見到嘅內容。';

export function normalizeScreenshotAttachment(value) {
  if (!value || !JPEG_DATA_URL.test(value.dataUrl) || (value.dataUrl.length - 23) % 4 !== 0 || value.dataUrl.length > MAX_DATA_URL_LENGTH
      || !Number.isInteger(value.width) || value.width < 1 || value.width > 1920
      || !Number.isInteger(value.height) || value.height < 1 || value.height > 1920) {
    throw new TypeError('Invalid screenshot attachment. Capture the screen again.');
  }
  const thumbnailDataUrl = typeof value.thumbnailDataUrl === 'string' && value.thumbnailDataUrl.length <= 200000
    && JPEG_DATA_URL.test(value.thumbnailDataUrl) ? value.thumbnailDataUrl : null;
  return Object.freeze({ dataUrl: value.dataUrl, thumbnailDataUrl, width: value.width, height: value.height, capturedAt: value.capturedAt });
}

export function screenshotMessageContent(text, attachment) {
  if (!attachment) return text;
  return [{ type: 'text', text }, { type: 'image_url', image_url: { url: attachment.dataUrl } }];
}
