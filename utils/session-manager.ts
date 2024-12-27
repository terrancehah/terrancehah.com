import { UserInteractionMetrics } from '../managers/stage-manager';

const SESSION_CONFIG = {
  INACTIVITY_TIMEOUT: 30 * 60 * 1000, // 30 minutes
  ABSOLUTE_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours
  STORAGE_KEYS: {
    SESSION: 'travel_session',
    METRICS: 'travel_interaction_metrics'
  }
};

interface SessionMetadata {
  sessionId: string;
  startTime: number;
  lastActive: number;
  expiresAt: number;
}

export function initializeSession(): SessionMetadata {
  const now = Date.now();
  const session: SessionMetadata = {
    sessionId: generateSessionId(),
    startTime: now,
    lastActive: now,
    expiresAt: now + SESSION_CONFIG.ABSOLUTE_TIMEOUT
  };
  
  localStorage.setItem(SESSION_CONFIG.STORAGE_KEYS.SESSION, JSON.stringify(session));
  return session;
}

export function checkSessionValidity(): boolean {
  const sessionData = localStorage.getItem(SESSION_CONFIG.STORAGE_KEYS.SESSION);
  if (!sessionData) return false;

  try {
    const session: SessionMetadata = JSON.parse(sessionData);
    const now = Date.now();

    // Check absolute timeout
    if (now >= session.expiresAt) {
      clearSession();
      return false;
    }

    // Check inactivity timeout
    if (now - session.lastActive >= SESSION_CONFIG.INACTIVITY_TIMEOUT) {
      clearSession();
      return false;
    }

    // Update last active timestamp
    session.lastActive = now;
    localStorage.setItem(SESSION_CONFIG.STORAGE_KEYS.SESSION, JSON.stringify(session));
    return true;
  } catch (error) {
    console.error('[SessionManager] Error parsing session:', error);
    clearSession();
    return false;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_CONFIG.STORAGE_KEYS.SESSION);
  localStorage.removeItem(SESSION_CONFIG.STORAGE_KEYS.METRICS);
}

export function updateLastActive() {
  const sessionData = localStorage.getItem(SESSION_CONFIG.STORAGE_KEYS.SESSION);
  if (!sessionData) return;

  try {
    const session: SessionMetadata = JSON.parse(sessionData);
    session.lastActive = Date.now();
    localStorage.setItem(SESSION_CONFIG.STORAGE_KEYS.SESSION, JSON.stringify(session));
  } catch (error) {
    console.error('[SessionManager] Error updating last active:', error);
  }
}

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Hook this into metrics management
export function getStoredMetricsWithSession(): UserInteractionMetrics | null {
  if (!checkSessionValidity()) {
    clearSession();
    return null;
  }

  const metricsData = localStorage.getItem(SESSION_CONFIG.STORAGE_KEYS.METRICS);
  if (!metricsData) return null;

  try {
    return JSON.parse(metricsData);
  } catch (error) {
    console.error('[SessionManager] Error parsing metrics:', error);
    return null;
  }
}
