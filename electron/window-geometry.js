// Constrain the full native window, regardless of which renderer panels are visible.
export function fitWindowToWorkArea(bounds, workArea) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height,
    workArea.x, workArea.y, workArea.width, workArea.height].every(Number.isFinite) ||
    bounds.width <= 0 || bounds.height <= 0 || workArea.width <= 0 || workArea.height <= 0) {
    throw new TypeError('Invalid window bounds');
  }
  const ratio = Math.min(1, workArea.width / bounds.width, workArea.height / bounds.height);
  const width = Math.max(1, Math.floor(bounds.width * ratio));
  const height = Math.max(1, Math.floor(bounds.height * ratio));
  return {
    x: Math.max(workArea.x, Math.min(Math.round(bounds.x), workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(Math.round(bounds.y), workArea.y + workArea.height - height)),
    width,
    height,
  };
}

export function constrainWindow(window, screen, requested = window.getBounds()) {
  const display = screen.getDisplayMatching(requested);
  const fitted = fitWindowToWorkArea(requested, display.workArea);
  const current = window.getBounds();
  if (Object.keys(fitted).some(key => fitted[key] !== current[key])) window.setBounds(fitted);
  return window.getBounds();
}

export function keepWindowOnScreen(window, screen) {
  let adjusting = false;
  const enforce = () => {
    if (adjusting || window.isDestroyed()) return;
    adjusting = true;
    try { constrainWindow(window, screen); }
    finally { adjusting = false; }
  };
  window.on('move', enforce);
  window.on('resize', enforce);
  screen.on('display-metrics-changed', enforce);
  screen.on('display-removed', enforce);
  window.once('closed', () => {
    screen.removeListener('display-metrics-changed', enforce);
    screen.removeListener('display-removed', enforce);
  });
  enforce();
}
