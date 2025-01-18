import { TravelSession } from '../managers/types';
import { STAGE_LIMITS } from '../managers/stage-manager';

export const SESSION_CONFIG = {
  STORAGE_KEY: 'travel_rizz_session',
  ABSOLUTE_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours
  INACTIVITY_TIMEOUT: 2 * 60 * 60 * 1000, // 2 hours
  WARNING_BEFORE_TIMEOUT: 5 * 60 * 1000, // 5 minutes warning
  MAX_TOTAL_INPUTS: 15,
  PAYMENT_REF_KEY: 'payment_reference_id'
};

// Safe storage access
export const getStorage = () => {
  if (typeof window !== 'undefined') {
    return window.sessionStorage;
  }
  return null;
};

export const storage = getStorage();

// Helper function to safely access storage
export const safeStorageOp = <T>(operation: () => T, defaultValue: T): T => {
  try {
    if (!storage) return defaultValue;
    return operation();
  } catch (error) {
    console.error('[Session] Storage operation failed:', error);
    return defaultValue;
  }
};

export function initializeSession(): TravelSession {
  const now = Date.now();
  
  // Try to get existing session first
  const existingSession = safeStorageOp(() => {
    const stored = storage?.getItem(SESSION_CONFIG.STORAGE_KEY);
    return stored ? JSON.parse(stored) as TravelSession : null;
  }, null);

  if (existingSession) {
    // Update both lastActive and expiresAt
    existingSession.lastActive = now;
    existingSession.expiresAt = now + SESSION_CONFIG.ABSOLUTE_TIMEOUT;
    // Ensure all stages are initialized
    existingSession.stagePrompts = existingSession.stagePrompts || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    safeStorageOp(() => {
      storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(existingSession));
    }, undefined);
    return existingSession;
  }

  // Create new session if none exists
  const sessionId = generateSessionId();
  const session: TravelSession = {
    // Session info
    sessionId,
    startTime: now,
    lastActive: now,
    expiresAt: now + SESSION_CONFIG.ABSOLUTE_TIMEOUT,

    // Travel details
    destination: '',
    startDate: '',
    endDate: '',
    preferences: [],
    budget: '',
    language: '',
    transport: [],
    location: {
      latitude: 0,
      longitude: 0
    },

    // Places
    savedPlaces: [],
    currentStage: 1,

    // Metrics
    totalPrompts: 0,
    stagePrompts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    savedPlacesCount: 0,

    // Payment
    isPaid: false,
    paymentReference: `session_${sessionId}`
  };

  safeStorageOp(() => {
    storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
  }, undefined);
  return session;
}

export function getStoredSession(): TravelSession | null {
  return safeStorageOp(() => {
    // console.log('[Session] Attempting to get stored session');
    const storedData = storage?.getItem(SESSION_CONFIG.STORAGE_KEY);
    if (!storedData) {
      console.log('[Session] No stored session data found');
      return null;
    }

    try {
      const session = JSON.parse(storedData);
      // console.log('[Session] Successfully parsed session:', {
      //   sessionId: session.sessionId,
      //   destination: session.destination,
      //   startTime: new Date(session.startTime).toISOString(),
      //   lastActive: new Date(session.lastActive).toISOString(),
      //   expiresAt: new Date(session.expiresAt).toISOString()
      // });
      return session;
    } catch (error) {
      console.error('[Session] Failed to parse session data:', error);
      return null;
    }
  }, null);
}

export function getStoredMetrics() {
  return safeStorageOp(() => {
    const session = getStoredSession();
    if (!session) return null;

    return {
      interaction: {
        totalPrompts: session.totalPrompts,
        stagePrompts: session.stagePrompts,
        lastActive: session.lastActive
      },
      places: {
        savedCount: session.savedPlacesCount
      },
      payment: {
        status: session.isPaid,
        reference: session.paymentReference,
        timestamp: session.paymentTimestamp
      },
      parameters: {
        destination: session.destination,
        dates: {
          start: session.startDate,
          end: session.endDate
        },
        preferences: session.preferences,
        budget: session.budget,
        language: session.language,
        transport: session.transport
      }
    };
  }, null);
}

export function updateStoredMetrics(
  currentStage: number,
  incrementPrompt: boolean = false,
  incrementSavedPlaces: boolean = false
): TravelSession {
  return safeStorageOp(() => {
    const session = getStoredSession() || initializeSession();

    if (incrementPrompt) {
      // Initialize stagePrompts with all stages if it doesn't exist
      if (!session.stagePrompts) {
        session.stagePrompts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      }
      
      // Ensure all stages exist
      for (let stage = 1; stage <= 5; stage++) {
        if (typeof session.stagePrompts[stage] !== 'number') {
          session.stagePrompts[stage] = 0;
        }
      }

      session.totalPrompts = (session.totalPrompts || 0) + 1;
      session.stagePrompts[currentStage] = (session.stagePrompts[currentStage] || 0) + 1;
    }

    if (incrementSavedPlaces) {
      session.savedPlacesCount = (session.savedPlacesCount || 0) + 1;
    }

    storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
    return session;
  }, null) || initializeSession();
}

export function checkInputLimits(currentStage: number): {
  withinStageLimit: boolean;
  withinTotalLimit: boolean;
  stageInputCount: number;
  totalInputCount: number;
} {
  return safeStorageOp(() => {
    const session = getStoredSession() || initializeSession();
    const stagePrompts = session.stagePrompts || { 1: 0, 2: 0, 3: 0 };
    const totalPrompts = session.totalPrompts || 0;

    return {
      withinStageLimit: currentStage === 3
        ? (stagePrompts[currentStage] || 0) < STAGE_LIMITS[3].maxPrompts
        : true,
      withinTotalLimit: currentStage === 3
        ? totalPrompts < SESSION_CONFIG.MAX_TOTAL_INPUTS
        : true,
      stageInputCount: stagePrompts[currentStage] || 0,
      totalInputCount: totalPrompts
    };
  }, {
    withinStageLimit: true,
    withinTotalLimit: true,
    stageInputCount: 0,
    totalInputCount: 0
  });
}

// Payment related functions
export function setPaymentStatus(isPaid: boolean): void {
  safeStorageOp(() => {
    const session = getStoredSession() || initializeSession();
    session.isPaid = isPaid;
    session.paymentTimestamp = isPaid ? Date.now() : undefined;
    storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
  }, undefined);
}

export function getPaymentStatus(): boolean {
  return safeStorageOp(() => {
    const session = getStoredSession();
    return session?.isPaid || false;
  }, false);
}

export function setPaymentReference(reference: string): void {
  safeStorageOp(() => {
    const session = getStoredSession() || initializeSession();
    session.paymentReference = reference;
    storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
  }, undefined);
}

export function getPaymentReference(): string | undefined {
  return safeStorageOp(() => {
    const session = getStoredSession();
    return session?.paymentReference;
  }, undefined);
}

export function clearPaymentReference(): void {
  safeStorageOp(() => {
    const session = getStoredSession() || initializeSession();
    session.paymentReference = '';
    storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
  }, undefined);
}

export function getPaymentReferenceId(): string | null {
  return safeStorageOp(() => {
    const stored = storage?.getItem(SESSION_CONFIG.PAYMENT_REF_KEY);
    return stored || null;
  }, null);
}

export function setPaymentReferenceId(referenceId: string) {
  safeStorageOp(() => {
    storage?.setItem(SESSION_CONFIG.PAYMENT_REF_KEY, referenceId);
    console.log('[Session] Stored payment reference ID:', referenceId);
  }, undefined);
}

export function checkSession(): boolean {
  return safeStorageOp(() => {
    const currentSession = storage?.getItem(SESSION_CONFIG.STORAGE_KEY);

    if (!currentSession) {
      const newSession = Date.now().toString();
      storage?.setItem(SESSION_CONFIG.STORAGE_KEY, newSession);
      return false;
    }
    return true;
  }, false);
}

// Add warning mechanism
export function checkSessionWithWarning(): { isValid: boolean; shouldWarn: boolean } {
  return safeStorageOp(() => {
    const session = getStoredSession();
    if (!session) {
      return { isValid: false, shouldWarn: false };
    }

    const now = Date.now();
    const timeLeft = session.expiresAt - now;
    const shouldWarn = timeLeft <= SESSION_CONFIG.WARNING_BEFORE_TIMEOUT;
    const isValid = timeLeft > 0;

    return { isValid, shouldWarn };
  }, { isValid: false, shouldWarn: false });
}

export function checkSessionValidity(): boolean {
  return safeStorageOp(() => {
    console.log('[Session] Checking session validity');
    const storedData = storage?.getItem(SESSION_CONFIG.STORAGE_KEY);
    if (!storedData) {
      console.log('[Session] No session found during validity check');
      return false;
    }

    let session;
    try {
      session = JSON.parse(storedData);
      console.log('[Session] Parsed session for validity check:', {
        sessionId: session.sessionId,
        destination: session.destination,
        startTime: new Date(session.startTime).toISOString(),
        lastActive: new Date(session.lastActive).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString()
      });
    } catch (error) {
      console.error('[Session] Failed to parse session during validity check:', error);
      return false;
    }

    const now = Date.now();
    console.log('[Session] Validity check times:', {
      now: new Date(now).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      lastActive: new Date(session.lastActive).toISOString(),
      timeTillExpiry: session.expiresAt - now,
      inactiveTime: now - session.lastActive,
      absoluteTimeout: SESSION_CONFIG.ABSOLUTE_TIMEOUT,
      inactivityTimeout: SESSION_CONFIG.INACTIVITY_TIMEOUT
    });

    // Check absolute timeout
    if (now >= session.expiresAt) {
      console.log('[Session] Session expired due to absolute timeout. Times:', {
        now,
        expiresAt: session.expiresAt,
        diff: now - session.expiresAt
      });
      clearSession();
      return false;
    }

    // Check inactivity timeout
    const inactiveTime = now - session.lastActive;
    if (inactiveTime >= SESSION_CONFIG.INACTIVITY_TIMEOUT) {
      console.log('[Session] Session expired due to inactivity. Times:', {
        now,
        lastActive: session.lastActive,
        inactiveTime,
        inactivityTimeout: SESSION_CONFIG.INACTIVITY_TIMEOUT
      });
      clearSession();
      return false;
    }

    // Only update lastActive if it's been more than 1 minute
    if (inactiveTime > 60000) { // 1 minute
      console.log('[Session] Updating lastActive time in validity check');
      session.lastActive = now;
      storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
    }
    
    return true;
  }, false);
}

// Session expiry handler
export function handleSessionExpiry() {
  safeStorageOp(() => {
    // Don't handle expiry if we're already on the landing page
    if (window.location.pathname === '/' || window.location.pathname === '') {
      return;
    }

    // Save current state if needed
    const currentState = {
      messages: window.getSavedPlaces?.() || [],
      lastUrl: window.location.pathname
    };
    storage?.setItem('expiredSessionState', JSON.stringify(currentState));

    // Clear session
    clearSession();

    // Only redirect if we're not already on the landing page
    const currentUrl = new URL(window.location.href);
    if (!currentUrl.searchParams.has('return')) {
      window.location.href = `/?return=${encodeURIComponent(currentState.lastUrl)}`;
    }
  }, undefined);
}

export function clearSession() {
  console.log('[Session] Clearing session storage');
  safeStorageOp(() => {
    storage?.removeItem(SESSION_CONFIG.STORAGE_KEY);
  }, undefined);
}

export function updateLastActive() {
  return safeStorageOp(() => {
    const storedData = storage?.getItem(SESSION_CONFIG.STORAGE_KEY);
    if (!storedData) {
      console.log('[Session] No session to update lastActive');
      return false;
    }

    try {
      const session = JSON.parse(storedData);
      session.lastActive = Date.now();
      storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
      console.log('[Session] Successfully updated lastActive');
      return true;
    } catch (error) {
      console.error('[Session] Failed to update lastActive:', error);
      return false;
    }
  }, false);
}

export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Update session with location
export function updateSessionLocation(location: { latitude: number; longitude: number }) {
  const session = getStoredSession();
  if (!session) return;

  session.location = location;
  safeStorageOp(() => {
    storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
  }, undefined);
}
