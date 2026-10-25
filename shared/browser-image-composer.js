import { normalizeScreenshotAttachment } from '../electron/screenshot-attachment.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const IMAGE_PROMPT = '請睇吓呢張圖片，簡短講吓你見到嘅內容。';

/** Convert only a user-selected image; no screen or camera access is requested. */
export async function prepareBrowserImage(file, {
  createImage = () => new Image(),
  createCanvas = () => document.createElement('canvas'),
  url = URL,
  now = Date.now
} = {}) {
  if (!file || !file.type?.startsWith('image/')) throw new Error('Choose a photo or screenshot.');
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('Choose an image smaller than 20 MB.');
  const objectUrl = url.createObjectURL(file);
  const image = createImage();
  let canvas;
  try {
    image.src = objectUrl;
    await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > 60_000_000) throw new Error('This image is too large. Choose a smaller image.');
    const scale = Math.min(1, 1920 / Math.max(width, height));
    canvas = createCanvas();
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare this image.');
    // JPEG has no transparency; give transparent screenshots a readable background.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let dataUrl;
    for (const quality of [0.8, 0.65, 0.5]) {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      if ((dataUrl.length - 23) / 4 * 3 <= MAX_JPEG_BYTES) break;
    }
    if ((dataUrl.length - 23) / 4 * 3 > MAX_JPEG_BYTES) throw new Error('This image is too large to attach. Choose a smaller image.');
    const result = { dataUrl, width: canvas.width, height: canvas.height, capturedAt: now() };
    // Keep a small preview in history rather than another full-resolution copy.
    const thumbnailScale = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
    canvas.width = Math.max(1, Math.round(canvas.width * thumbnailScale));
    canvas.height = Math.max(1, Math.round(canvas.height * thumbnailScale));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    result.thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.6);
    return normalizeScreenshotAttachment(result);
  } catch (error) {
    if (error?.name === 'EncodingError') throw new Error('This image format could not be opened. Try a JPEG or PNG.');
    throw error;
  } finally {
    url.revokeObjectURL(objectUrl);
    image.removeAttribute('src');
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/** Same draft/send boundary as Electron's screenshot composer. */
export function createBrowserImageComposer({ captureButton, fileInput, preview, image, removeButton, status, prepare = prepareBrowserImage }) {
  let attachment = null, preparing = false, disabled = false;
  const render = () => {
    captureButton.disabled = fileInput.disabled = disabled || preparing;
    removeButton.disabled = disabled || preparing;
    captureButton.textContent = preparing ? '…' : '📷';
    captureButton.title = attachment ? 'Replace attached image' : 'Attach a photo or screenshot';
    preview.hidden = !attachment;
    if (attachment) image.src = attachment.dataUrl;
    else image.removeAttribute('src');
  };
  captureButton.addEventListener('click', () => {
    if (!disabled && !preparing) fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // Allow choosing the same photo again.
    if (!file || disabled || preparing) return;
    preparing = true;
    status.textContent = 'Preparing image…';
    render();
    try {
      attachment = await prepare(file);
      status.textContent = 'Image attached. Press Send to share it.';
    } catch (error) { status.textContent = error.message; }
    finally { preparing = false; render(); }
  });
  removeButton.addEventListener('click', () => {
    if (disabled || preparing) return;
    attachment = null; status.textContent = ''; render();
  });
  render();
  return {
    getAttachment: () => attachment,
    getText: text => text.trim() || (attachment ? IMAGE_PROMPT : ''),
    isCapturing: () => preparing,
    setDisabled(value) { disabled = value; render(); },
    clear(sentAttachment) {
      if (sentAttachment && attachment !== sentAttachment) return;
      attachment = null; status.textContent = ''; render();
    }
  };
}
