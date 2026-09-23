/**
 * HistoryModule - Chat history management using localStorage
 * Ported from Electron version
 */

import { CONFIG } from '../config.js';
import logger from '../logger.js';

const HISTORY_KEY = 'hikari_chat_history';
const MAX_HISTORY_ITEMS = 1000;

export function getHistory() {
    try {
        const data = localStorage.getItem(HISTORY_KEY);
        return data ? JSON.parse(data) : [];
    } catch (error) {
        logger.error('history', 'Failed to load history:', error);
        return [];
    }
}

export function saveHistory(history) {
    try {
        const trimmed = history.slice(-MAX_HISTORY_ITEMS);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
        logger.debug('history', 'History saved, items:', trimmed.length);
    } catch (error) {
        logger.error('history', 'Failed to save history:', error);
    }
}

export function addHistoryEntry(entry) {
    const history = getHistory();
    history.push({
        ...entry,
        timestamp: Date.now(),
        id: 'hist-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8)
    });
    saveHistory(history);
    logger.info('history', 'Added entry:', entry.type || 'unknown');
    return history;
}

export function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    logger.info('history', 'History cleared');
}

export function getRecentHistory(limit = CONFIG.HISTORY_BATCH_SIZE) {
    const history = getHistory();
    return history.slice(-limit);
}

export function searchHistory(query, limit = 50) {
    const history = getHistory();
    const lowerQuery = query.toLowerCase();
    return history
        .filter(item => JSON.stringify(item).toLowerCase().includes(lowerQuery))
        .slice(-limit);
}

export function exportHistory() {
    const history = getHistory();
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hikari-history-' + new Date().toISOString().split('T')[0] + '.json';
    a.click();
    URL.revokeObjectURL(url);
    logger.info('history', 'History exported');
}

export function importHistory(jsonText) {
    try {
        const history = JSON.parse(jsonText);
        if (Array.isArray(history)) {
            saveHistory(history);
            logger.info('history', 'History imported, items:', history.length);
            return true;
        }
    } catch (error) {
        logger.error('history', 'Failed to import history:', error);
    }
    return false;
}

export const HistoryModule = {
    getHistory,
    saveHistory,
    addHistoryEntry,
    clearHistory,
    getRecentHistory,
    searchHistory,
    exportHistory,
    importHistory
};

export default HistoryModule;