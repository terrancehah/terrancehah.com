import { useState } from 'react';
import { TravelDetails } from '../managers/types';
import { Place } from '../utils/places-utils';
import { UserInteractionMetrics } from '../managers/stage-manager';

interface UseTravelToolsProps {
  currentDetails: TravelDetails;
  setCurrentDetails: (details: TravelDetails) => void;
  currentStage: number;
  onStageUpdate: (nextStage: number) => void;
  userMetrics: UserInteractionMetrics;
  append: (message: any, options?: any) => Promise<void>;
  savedPlaces: Place[];
}

export function useTravelTools({
  currentDetails,
  setCurrentDetails,
  currentStage,
  onStageUpdate,
  userMetrics,
  append,
  savedPlaces
}: UseTravelToolsProps) {
  const [toolVisibility, setToolVisibility] = useState<Record<string, boolean>>({});

  const handleToolUpdate = async (message: any) => {
    if (!message.toolInvocations?.[0]) return;

    const toolInvocation = message.toolInvocations[0];
    const { toolCallId, result, toolName } = toolInvocation;

    if (!result) return;

    console.log('[useTravelTools] Processing tool:', {
      toolName,
      toolCallId,
      resultType: result.type,
      props: result.props
    });

    // Only hide non-quick response tools immediately
    if (toolCallId && result.type !== 'quickResponse') {
      console.log('[useTravelTools] Hiding tool:', toolCallId);
      setToolVisibility(prev => ({
        ...prev,
        [toolCallId]: false
      }));
    }

    // Handle different tool types
    switch (result.type) {
      case 'budgetSelector':
        if (result.props?.currentBudget) {
          setCurrentDetails({ ...currentDetails, budget: result.props.currentBudget });
          // Send confirmation message
          await append({
            role: 'user',
            content: `I've set my budget to ${result.props.currentBudget}`
          });
        }
        break;

      case 'preferenceSelector':
        if (result.props?.currentPreferences) {
          setCurrentDetails({ ...currentDetails, preferences: result.props.currentPreferences });
          // Send confirmation message
          await append({
            role: 'user',
            content: `I've updated my preferences to: ${result.props.currentPreferences.join(', ')}.`
          });
        }
        break;

      case 'datePicker':
        if (result.props?.startDate && result.props?.endDate) {
          setCurrentDetails({
            ...currentDetails,
            startDate: result.props.startDate,
            endDate: result.props.endDate
          });
          // Send confirmation message
          await append({
            role: 'user',
            content: `I've changed my travel dates to ${result.props.startDate} - ${result.props.endDate}.`
          });
        }
        break;

      case 'languageSelector':
        if (result.props?.currentLanguage) {
          setCurrentDetails({ ...currentDetails, language: result.props.currentLanguage });
          // Send confirmation message
          await append({
            role: 'user',
            content: `I've set my language preference to ${result.props.currentLanguage}.`
          });
        }
        break;

      case 'stageProgress':
        if (result.props?.nextStage) {
          onStageUpdate(result.props.nextStage);
        }
        break;

      case 'savedPlacesList':
        // Keep the list visible
        if (toolCallId) {
          setToolVisibility(prev => ({
            ...prev,
            [toolCallId]: true
          }));
        }
        break;

      case 'quickResponse':
        // Don't hide quick responses immediately
        if (toolCallId) {
          setToolVisibility(prev => ({
            ...prev,
            [toolCallId]: true
          }));
        }
        break;
    }
  };

  return {
    toolVisibility,
    setToolVisibility,
    handleToolUpdate
  };
}
