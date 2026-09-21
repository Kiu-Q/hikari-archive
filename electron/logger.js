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
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) {
    const details = value.stack || `${value.name}: ${value.message}`;
    return details.replaceAll('\n', '\\n');
  }
  if (typeof Event !== 'undefined' && value instanceof Event) {
    const eventError = value.error instanceof Error
      ? `: ${formatValue(value.error)}`
      : value.message
        ? `: ${value.message}`
        : '';
    return `Event(${value.type || 'unknown'})${eventError}`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_key, nestedValue) => {
        if (nestedValue instanceof Error) {
          return {
            name: nestedValue.name,
            message: nestedValue.message,
            stack: nestedValue.stack
          };
        }
        return nestedValue;
      });
    } catch (error) {
      return String(value);
    }
  }
  return String(value);
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