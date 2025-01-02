import { UserInteractionMetrics, STAGE_LIMITS } from '../managers/stage-manager';
import { checkSessionValidity, initializeSession, clearSession } from './session-manager';

const METRICS_STORAGE_KEY = 'travel_interaction_metrics';
const SESSION_KEY = 'travel_session_id';
const MAX_TOTAL_INPUTS = 15;

export function getStoredMetrics(): UserInteractionMetrics {
  try {
    // Check session validity first
    if (!checkSessionValidity()) {
      return resetMetrics();
    }

    const storedMetrics = localStorage.getItem(METRICS_STORAGE_KEY);
    if (!storedMetrics) {
      return resetMetrics();
    }

    const metrics = JSON.parse(storedMetrics);
    
    // Ensure all fields exist
    metrics.totalPrompts = metrics.totalPrompts || 0;
    metrics.savedPlacesCount = metrics.savedPlacesCount || 0;
    metrics.isPaid = metrics.isPaid || false;
    metrics.stagePrompts = metrics.stagePrompts || { 1: 0, 2: 0, 3: 0 };

    return metrics;
  } catch (error) {
    console.error('[Metrics] Error retrieving metrics:', error);
    return resetMetrics();
  }
}

export function updateStoredMetrics(
  currentStage: number, 
  incrementPrompt: boolean = true
): UserInteractionMetrics {
  try {
    const metrics = getStoredMetrics();
    
    if (incrementPrompt) {
      // Only increment if explicitly requested and not already at limit
      const { withinStageLimit } = checkInputLimits(currentStage);
      if (withinStageLimit) {
        metrics.totalPrompts += 1;
        if (!metrics.stagePrompts) {
          metrics.stagePrompts = {};
        }
        metrics.stagePrompts[currentStage] = (metrics.stagePrompts[currentStage] || 0) + 1;
      }
    }
    
    // Save to storage
    localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(metrics));
    
    return metrics;
  } catch (error) {
    console.error('[Metrics] Error updating metrics:', error);
    return getStoredMetrics();
  }
}

export function checkInputLimits(
  currentStage: number
): { 
  withinStageLimit: boolean, 
  withinTotalLimit: boolean,
  stageInputCount: number,
  totalInputCount: number
} {
  const metrics = getStoredMetrics();
  
  const stagePrompts = metrics.stagePrompts?.[currentStage] || 0;
  const totalPrompts = metrics.totalPrompts || 0;

   // Only apply stage limits to stage 3, all other stages should be unlimited
  const result = {
    withinStageLimit: currentStage === 3 ? 
      stagePrompts < STAGE_LIMITS[3].maxPrompts : 
      true,  // Always true for non-stage 3
    withinTotalLimit: currentStage === 3 ? 
      totalPrompts < MAX_TOTAL_INPUTS :
      true,  // Always true for non-stage 3
    stageInputCount: stagePrompts,
    totalInputCount: totalPrompts
  };

  console.log(`[Metrics] Input limit check for stage ${currentStage}:`, result);
  
  return result;
}

export function resetMetrics() {
  const metrics = {
    totalPrompts: 0,
    savedPlacesCount: 0,
    isPaid: false,
    stagePrompts: { 1: 0, 2: 0, 3: 0 }
  };
  localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(metrics));
  initializeSession(); // Initialize a new session when metrics are reset
  return metrics;
}

export function checkSession(): boolean {
  const currentSession = localStorage.getItem(SESSION_KEY);
  
  if (!currentSession) {
    const newSession = Date.now().toString();
    localStorage.setItem(SESSION_KEY, newSession);
    resetMetrics();
    return false;
  }
  return true;
}
