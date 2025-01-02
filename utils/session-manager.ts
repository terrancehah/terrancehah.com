import { UserInteractionMetrics } from '../managers/stage-manager';

const SESSION_CONFIG = {
  INACTIVITY_TIMEOUT: 2 * 60 * 60 * 1000, // 2 hours
  ABSOLUTE_TIMEOUT: 24 * 60 * 60 * 1000, // keep 24 hours
  WARNING_BEFORE_TIMEOUT: 5 * 60 * 1000, // 5 minutes warning
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

// Add warning mechanism
export function checkSessionWithWarning(): { isValid: boolean; shouldWarn: boolean } {
  const sessionData = localStorage.getItem(SESSION_CONFIG.STORAGE_KEYS.SESSION);
  if (!sessionData) return { isValid: false, shouldWarn: false };

  try {
    const session: SessionMetadata = JSON.parse(sessionData);
    const now = Date.now();
    const timeUntilInactivity = (session.lastActive + SESSION_CONFIG.INACTIVITY_TIMEOUT) - now;
    
    // Check if we should show warning
    if (timeUntilInactivity > 0 && timeUntilInactivity <= SESSION_CONFIG.WARNING_BEFORE_TIMEOUT) {
      return { isValid: true, shouldWarn: true };
    }

    // Regular validity check
    if (now >= session.expiresAt || now - session.lastActive >= SESSION_CONFIG.INACTIVITY_TIMEOUT) {
      return { isValid: false, shouldWarn: false };
    }

    return { isValid: true, shouldWarn: false };
  } catch (error) {
    console.error('[SessionManager] Error checking session:', error);
    return { isValid: false, shouldWarn: false };
  }
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

// ession expiry handler
export function handleSessionExpiry() {
  // Save current state if needed
  const currentState = {
    messages: window.getSavedPlaces?.() || [],
    lastUrl: window.location.pathname
  };
  localStorage.setItem('expiredSessionState', JSON.stringify(currentState));
  
  // Clear session
  clearSession();
  
  // Redirect to landing page with return path
  window.location.href = `/?return=${encodeURIComponent(currentState.lastUrl)}`;
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
