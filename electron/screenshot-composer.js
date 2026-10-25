import { normalizeScreenshotAttachment, SCREENSHOT_DEFAULT_PROMPT } from './screenshot-attachment.js';

/** Keep the draft attachment local until the normal Send button is pressed. */
export function createScreenshotComposer({ api, captureButton, preview, image, removeButton, status, permissionButton }) {
  let attachment = null, capturing = false, disabled = false;
  const render = () => {
    captureButton.disabled = disabled || capturing;
    removeButton.disabled = disabled || capturing;
    captureButton.textContent = capturing ? '…' : '📷';
    captureButton.title = attachment ? 'Retake screenshot' : 'Capture current screen';
    preview.hidden = !attachment;
    if (attachment) image.src = attachment.dataUrl;
    else image.removeAttribute('src');
  };
  captureButton.addEventListener('click', async () => {
    if (disabled || capturing) return;
    capturing = true;
    permissionButton.hidden = true;
    status.textContent = 'Capturing screen…';
    render();
    try {
      const result = await api.capture();
      if (!result?.ok) {
        permissionButton.hidden = result?.error?.code !== 'SCREEN_PERMISSION_REQUIRED';
        throw new Error(result?.error?.message || 'Could not capture the current screen.');
      }
      attachment = normalizeScreenshotAttachment(result.attachment);
      status.textContent = 'Screenshot attached. Press Send to share it.';
    } catch (error) { status.textContent = error.message; }
    finally { capturing = false; render(); }
  });
  removeButton.addEventListener('click', () => {
    if (disabled || capturing) return;
    attachment = null; status.textContent = ''; render();
  });
  permissionButton.addEventListener('click', async () => {
    permissionButton.disabled = true;
    try {
      await api.openPermissionSettings();
      status.textContent = 'Allow Screen Recording for Hikari, then press 📷 again. macOS may require an app restart.';
    } catch (error) { status.textContent = error.message; }
    finally { permissionButton.disabled = false; }
  });
  render();
  return {
    getAttachment: () => attachment,
    getText: text => text.trim() || (attachment ? SCREENSHOT_DEFAULT_PROMPT : ''),
    isCapturing: () => capturing,
    setDisabled(value) { disabled = value; render(); },
    clear(sentAttachment) {
      if (sentAttachment && attachment !== sentAttachment) return;
      attachment = null; status.textContent = ''; render();
    }
  };
}
