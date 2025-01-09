import { TravelDetails } from './types';
import { checkInputLimits } from '../utils/local-metrics';

// Interface for tracking user interactions
export interface UserInteractionMetrics {
  totalPrompts: number;
  savedPlacesCount: number;
  isPaid: boolean;
  stagePrompts?: Record<number, number>;
  paymentReference?: string; // Track payment reference ID
}

// Define requirements for each stage
interface StageRequirements {
  validate: (
    travelDetails: TravelDetails,
    metrics: UserInteractionMetrics
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
    validate: (details: TravelDetails, metrics: UserInteractionMetrics) => {
      return {
        isValid: true,
        missingRequirements: []
      };
    }
  },

  // Stage 3: Places Introduction
  3: {
    validate: (_, metrics: UserInteractionMetrics) => {
      const stagePrompts = metrics.stagePrompts?.[3] || 0;
      const maxPrompts = STAGE_LIMITS[3].maxPrompts;

      if (stagePrompts >= maxPrompts) {
        return {
          isValid: true, // Allow progression to stage 4
          missingRequirements: ['Maximum places limit reached. Ready for upgrade.'],
          upgradeRequired: true
        };
      }

      return {
        isValid: false,
        missingRequirements: ['Continue adding places']
      };
    }
  },

  // Stage 4: Itinerary Review (with payment check)
  4: {
    validate: (_, metrics: UserInteractionMetrics) => {
      const missingRequirements: string[] = [];
      
      // Only allow progression if user has paid
      if (!metrics.isPaid) {
        missingRequirements.push('payment required');
      }

      return {
        isValid: metrics.isPaid,
        missingRequirements
      };
    }
  },

  // Stage 5: Final Confirmation (keeping it open as requested)
  5: {
    validate: (_, metrics: UserInteractionMetrics) => {
      const missingRequirements: string[] = [];
      
      // First validate Stage 1 parameters
      const stage1Validator = STAGE_VALIDATORS[1];
      const stage1Result = stage1Validator.validate(_, metrics);
      if (!stage1Result.isValid) {
        return stage1Result;
      }

      return {
        isValid: true,
        missingRequirements
      };
    }
  }
};

// Main validation function to be used in the chat component
export function validateStageProgression(
  currentStage: number,
  nextStage: number,
  travelDetails: TravelDetails,
  metrics: UserInteractionMetrics
): {
  canProgress: boolean;
  missingRequirements: string[];
  upgradeRequired?: boolean;
} {
  // Ensure stage progression is sequential
  if (nextStage !== currentStage + 1) {
    return {
      canProgress: false,
      missingRequirements: ['invalid stage progression']
    };
  }

  // Get validator for the current stage
  const validator = STAGE_VALIDATORS[currentStage];
  if (!validator) {
    return {
      canProgress: false,
      missingRequirements: ['invalid stage']
    };
  }

  // Run validation
  const { isValid, missingRequirements, upgradeRequired } = validator.validate(travelDetails, metrics);

  return {
    canProgress: isValid,
    missingRequirements,
    upgradeRequired
  };
}
