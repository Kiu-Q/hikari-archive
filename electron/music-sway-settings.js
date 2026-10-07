export function setupMusicSwaySettings({ api, document, storage, onSignal = () => {}, onEnabledChange = () => {} }) {
  const toggle = document.getElementById('musicSwayToggle');
  const label = document.getElementById('musicSwayStatus');
  const permission = document.getElementById('musicSwayPermission');
  if (!api || !toggle) return () => {};
  let generation = 0, disposed = false, warning = '';
  const renderStatus = status => {
    if (disposed) return;
    warning = status.warning || '';
    if (label) label.textContent = status.state === 'error' ? status.reason
      : status.state === 'starting' ? 'Starting music analysis…'
      : status.state === 'listening' ? warning || 'Listening — waiting for music' : 'Off';
    if (permission) permission.hidden = status.state !== 'error' && !warning;
    if (status.state === 'error') {
      const wasEnabled = toggle.checked;
      toggle.checked = false; storage.setItem('music_sway_enabled', 'false'); onSignal(null);
      if (wasEnabled) onEnabledChange(false);
    }
  };
  const change = async () => {
    const current = ++generation;
    storage.setItem('music_sway_enabled', String(toggle.checked));
    onEnabledChange(toggle.checked);
    if (!toggle.checked) onSignal(null);
    try {
      const status = await api.setEnabled(toggle.checked);
      if (current === generation) renderStatus(status);
    } catch {
      if (current === generation) renderStatus({ state: 'error', reason: 'Music analysis is unavailable. Try enabling it again.' });
    }
  };
  const signal = value => {
    if (!toggle.checked || disposed) return;
    onSignal(value);
    if (label && (!warning || value.active)) label.textContent = value.active
      ? value.intervalMs ? `Following music · ${Math.round(60000 / value.intervalMs)} BPM` : 'Listening for the beat…'
      : 'Listening — waiting for music';
  };
  const openPermission = () => { void Promise.resolve(api.openPermissionSettings()).catch(() => {}); };
  const offSignal = api.onSignal(signal), offStatus = api.onStatus(renderStatus);
  toggle.checked = storage.getItem('music_sway_enabled') === 'true';
  toggle.addEventListener('change', change);
  permission?.addEventListener('click', openPermission);
  if (toggle.checked) void change();
  return () => {
    disposed = true; generation++;
    toggle.removeEventListener('change', change); permission?.removeEventListener('click', openPermission);
    offSignal?.(); offStatus?.(); onSignal(null);
  };
}
