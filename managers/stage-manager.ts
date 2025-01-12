import { TravelDetails, TravelSession } from './types';
import { getStoredSession, initializeSession } from '../utils/session-manager';

// Interface for tracking user interactions
// export interface UserInteractionMetrics {
//   totalPrompts: number;
//   savedPlacesCount: number;
//   isPaid: boolean;
//   stagePrompts?: Record<number, number>;
//   paymentReference: string; // Track payment reference ID - required
// }

// Define requirements for each stage
interface StageRequirements {
  validate: (
    travelDetails: TravelDetails,
    session: TravelSession
  ) => {
    isValid: boolean;
    missingRequirements: string[];
    upgradeRequired?: boolean;
  };
}

// Validation functions for each stage
export const STAGE_LIMITS = {
  3: {
    maxPrompts: 5,
    upgradeMessage: `I'm sorry to tell you that you have reached the prompts limit in the free version. 
    Would you like to upgrade to unlock unlimited places browsing and premium features? 
    This will give you access to personalized recommendations, detailed scheduling, and local insights.`
  }
} as const;

const STAGE_VALIDATORS: Record<number, StageRequirements> = {
  // Stage 1: Initial Parameter Check
  1: {
    validate: (details: TravelDetails) => {
      const missingRequirements: string[] = [];
      
      if (!details.destination) missingRequirements.push('destination');
      if (!details.startDate) missingRequirements.push('start date');
      if (!details.endDate) missingRequirements.push('end date');
      if (!details.preferences?.length) missingRequirements.push('preferences');
      if (!details.language) missingRequirements.push('language');
      
      return {
        isValid: missingRequirements.length === 0,
        missingRequirements
      };
    }
  },

  // Stage 2: City Introduction
  2: {
    validate: (details: TravelDetails, session: TravelSession) => {
      return {
        isValid: true,
        missingRequirements: []
      };
    }
  },

  // Stage 3: Places Introduction
  3: {
    validate: (_, session: TravelSession) => {
      const { totalPrompts, stagePrompts } = session;
      const stagePromptCount = stagePrompts?.[3] || 0;
      const upgradeRequired = !session.isPaid && stagePromptCount >= STAGE_LIMITS[3].maxPrompts;

      return {
        isValid: !upgradeRequired,
        missingRequirements: [],
        upgradeRequired
      };
    }
  },

  // Stage 4: Itinerary Review (with payment check)
  4: {
    validate: (_, session: TravelSession) => {
      const isPaid = session.isPaid;
      return {
        isValid: isPaid,
        missingRequirements: isPaid ? [] : ['premium subscription'],
        upgradeRequired: !isPaid
      };
    }
  },

  // Stage 5: Final Confirmation (keeping it open as requested)
  5: {
    validate: (_, session: TravelSession) => {
      const isPaid = session.isPaid;
      return {
        isValid: isPaid,
        missingRequirements: isPaid ? [] : ['premium subscription'],
        upgradeRequired: !isPaid
      };
    }
  }
};

// Main validation function to be used in the chat component
export function validateStageProgression(
  currentStage: number,
  nextStage: number,
  travelDetails: TravelDetails
): {
  canProgress: boolean;
  missingRequirements: string[];
  upgradeRequired?: boolean;
} {
  let session = getStoredSession();
  
  // If no session exists but we have travel details, initialize one
  if (!session && travelDetails.destination) {
    session = initializeSession();
    session.destination = travelDetails.destination;
    session.startDate = travelDetails.startDate || '';
    session.endDate = travelDetails.endDate || '';
    session.preferences = travelDetails.preferences || [];
    session.budget = travelDetails.budget || '';
    session.language = travelDetails.language || '';
    session.transport = travelDetails.transport || [];
    session.currentStage = currentStage;
  }

  if (!session) {
    return {
      canProgress: false,
      missingRequirements: ['valid session']
    };
  }

  // Ensure stage progression is sequential
  if (nextStage !== currentStage + 1) {
    return {
      canProgress: false,
      missingRequirements: ['invalid stage progression']
    };
  }

  // Get validator for next stage
  const validator = STAGE_VALIDATORS[nextStage];
  if (!validator) {
    return {
      canProgress: true,
      missingRequirements: []
    };
  }

  // Check if we can move to next stage
  const { isValid, missingRequirements, upgradeRequired } = validator.validate(
    travelDetails,
    session
  );

  return {
    canProgress: isValid,
    missingRequirements,
    upgradeRequired
  };
}
