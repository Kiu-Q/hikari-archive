export const activeWindowOptions = Object.freeze({
  accessibilityPermission: false,
  // get-windows' native helper has its own macOS TCC identity. Keep it from
  // requesting Screen Recording; Electron's desktopCapturer owns that access.
  screenRecordingPermission: false
});
