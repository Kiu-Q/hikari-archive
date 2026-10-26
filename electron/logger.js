/**
 * Unified Logger for Hikari Electron App
 * Format: [LEVEL] [timestamp] [category] message
 * Example: [INFO] [2026-01-15 10:30:00] [lip] startSpeaking hello
 */

function formatTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatValue(value) {
  const maxLength = 2000;
  const truncationMarker = '... [truncated]';
  const truncate = text => text.length > maxLength
    ? text.slice(0, maxLength - truncationMarker.length) + truncationMarker : text;
  const ancestors = new WeakSet();
  let remainingEntries = 100;

  function summarize(nestedValue, depth) {
    if (typeof nestedValue === 'string') return truncate(nestedValue);
    if (typeof nestedValue === 'bigint') return String(nestedValue);
    if (typeof nestedValue === 'function' || typeof nestedValue === 'symbol') return undefined;
    if (nestedValue === null || typeof nestedValue !== 'object') return nestedValue;
    if (ancestors.has(nestedValue)) return '[Circular]';
    if (depth >= 4) return '[Max depth]';
    if (remainingEntries <= 0) return truncationMarker;
    ancestors.add(nestedValue);
    try {
      const source = nestedValue instanceof Error
        ? { name: nestedValue.name, message: nestedValue.message, stack: nestedValue.stack }
        : nestedValue;
      const result = Array.isArray(source) ? [] : Object.create(null);
      let count = 0;
      for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (count >= 20 || remainingEntries <= 0) {
          if (Array.isArray(result)) result.push(truncationMarker);
          else result['...'] = truncationMarker;
          break;
        }
        count++;
        remainingEntries--;
        const summary = summarize(source[key], depth + 1);
        if (Array.isArray(result)) result.push(summary);
        else result[truncate(key)] = summary;
      }
      return result;
    } finally {
      ancestors.delete(nestedValue);
    }
  }

  try {
    if (value instanceof Error) {
      const details = value.stack || `${value.name}: ${value.message}`;
      return truncate(details.replaceAll('\n', '\\n'));
    }
    if (typeof Event !== 'undefined' && value instanceof Event) {
      const eventError = value.error instanceof Error
        ? `: ${formatValue(value.error)}`
        : value.message
          ? `: ${value.message}`
          : '';
      return truncate(`Event(${value.type || 'unknown'})${eventError}`);
    }
    if (value !== null && typeof value === 'object') {
      return truncate(JSON.stringify(summarize(value, 0)));
    }
    return truncate(String(value));
  } catch {
    return '[Unformattable value]';
  }
}

function formatArgs(args) {
  return args.map(formatValue).join(' ');
}

class Logger {
  constructor() {
    this.levels = {
      DEBUG: 0,
      INFO: 1,
      WARN: 2,
      ERROR: 3
    };
    this.currentLevel = this.levels.INFO; // Default to INFO
  }

  setLevel(level) {
    const upperLevel = level.toUpperCase();
    if (this.levels[upperLevel] !== undefined) {
      this.currentLevel = this.levels[upperLevel];
    }
  }

  _log(level, category, ...args) {
    if (this.levels[level] < this.currentLevel) return;
    
    const timestamp = formatTimestamp();
    const message = formatArgs(args);
    const output = `[${level}] [${timestamp}] [${category}] ${message}`;
    
    // Use native console methods for proper coloring in DevTools
    switch (level) {
      case 'DEBUG':
        console.debug(output);
        break;
      case 'INFO':
        console.log(output);
        break;
      case 'WARN':
        console.warn(output);
        break;
      case 'ERROR':
        console.error(output);
        break;
    }
  }

  debug(category, ...args) {
    this._log('DEBUG', category, ...args);
  }

  info(category, ...args) {
    this._log('INFO', category, ...args);
  }

  warn(category, ...args) {
    this._log('WARN', category, ...args);
  }

  error(category, ...args) {
    this._log('ERROR', category, ...args);
  }
}

// Export singleton instance
const logger = new Logger();

export default logger;
export { Logger };
