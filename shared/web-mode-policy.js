const DISALLOWED_PREFIX = /^(?:idle_)?(?:sit|walk)/i;
const DISALLOWED_STARTUP_ANIMATION = /^start_1standup(?:\.vrma)?$/i;

function getAnimationName(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;

  let pathname;
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return null;
    pathname = url.pathname;
  } else {
    pathname = input.split(/[?#]/, 1)[0];
  }

  if (!pathname || pathname.endsWith('/') || pathname.endsWith('\\')) return null;
  const filename = pathname.split(/[\\/]/).pop();
  if (!filename) return null;

  try {
    return decodeURIComponent(filename).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Return whether an animation may play in Hikari's browser client.
 * The browser omits sitting, walking, and the seated stand-up startup clip.
 * Electron's animation policy remains managed by its own caller.
 */
export function isWebAnimationAllowed(urlOrName) {
  const name = getAnimationName(urlOrName);
  if (!name) return false;
  if (DISALLOWED_PREFIX.test(name)) return false;
  return !DISALLOWED_STARTUP_ANIMATION.test(name);
}
