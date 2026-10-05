export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 1920;

function captureError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Manual, one-shot capture of the display containing the composer window. */
export function createScreenCaptureService({ getSources, getDisplay, getPermissionStatus = () => 'granted', platform = process.platform, now = () => Date.now(), captureTimeoutMs = 15000 }) {
  let capturing = false;
  return {
    async capture() {
      if (capturing) throw captureError('CAPTURE_BUSY', 'A screenshot is already being captured.');
      capturing = true;
      try {
        if (platform === 'darwin' && getPermissionStatus() !== 'granted') {
          throw captureError('SCREEN_PERMISSION_REQUIRED', 'Allow Screen Recording for Hikari in macOS Settings, then capture again.');
        }
        const display = getDisplay();
        if (!display?.size?.width || !display?.size?.height) throw captureError('CAPTURE_UNAVAILABLE', 'The current display is unavailable.');
        const scale = Math.min(1, MAX_DIMENSION / Math.max(display.size.width, display.size.height));
        let captureTimer;
        let sources;
        try {
          sources = await Promise.race([
            getSources({
              types: ['screen'], fetchWindowIcons: false,
              thumbnailSize: { width: Math.max(1, Math.round(display.size.width * scale)), height: Math.max(1, Math.round(display.size.height * scale)) }
            }),
            new Promise((_, reject) => {
              captureTimer = setTimeout(() => reject(captureError('CAPTURE_TIMEOUT', 'Screen capture timed out. Check Screen Recording permission and try again.')), captureTimeoutMs);
            })
          ]);
        } finally { clearTimeout(captureTimer); }
        const source = sources.find(item => String(item.display_id) === String(display.id));
        let image = source?.thumbnail;
        if (!image || image.isEmpty()) throw captureError('CAPTURE_UNAVAILABLE', 'No screenshot was returned for the current display.');
        let size = image.getSize();
        if (Math.max(size.width, size.height) > MAX_DIMENSION) {
          const ratio = MAX_DIMENSION / Math.max(size.width, size.height);
          image = image.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio), quality: 'good' });
        }
        let jpeg;
        for (const quality of [80, 65, 50]) {
          jpeg = image.toJPEG(quality);
          if (jpeg.length <= MAX_SCREENSHOT_BYTES) break;
        }
        if (!jpeg?.length || jpeg.length > MAX_SCREENSHOT_BYTES) throw captureError('SCREENSHOT_TOO_LARGE', 'The screenshot is too large. Try capturing a smaller display.');
        size = image.getSize();
        const thumbnail = image.resize({ width: Math.min(320, size.width), quality: 'good' }).toJPEG(65);
        return {
          mimeType: 'image/jpeg', width: size.width, height: size.height, capturedAt: now(),
          dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
          thumbnailDataUrl: `data:image/jpeg;base64,${thumbnail.toString('base64')}`
        };
      } finally { capturing = false; }
    }
  };
}
