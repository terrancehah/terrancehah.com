import { useState } from 'react';
import { TravelDetails, TravelSession } from '../managers/types';
import { Place } from '../utils/places-utils';
import { getStoredSession, safeStorageOp, storage, SESSION_CONFIG } from '../utils/session-manager';

interface UseTravelToolsProps {
  currentDetails: TravelDetails;
  setCurrentDetails: (details: TravelDetails) => void;
  currentStage: number;
  onStageUpdate: (nextStage: number) => void;
  userMetrics: TravelSession;
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

  // Helper function to update session storage
  const updateSessionDetails = (updates: Partial<TravelDetails>) => {
    const session = getStoredSession();
    if (!session) return;

    safeStorageOp(() => {
      storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify({
        ...session,
        ...updates,
        lastActive: Date.now()
      }));
    }, undefined);
  };

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

    // Handle different tool types
    switch (result.type) {
      case 'budgetSelector':
        // Only show selector, don't update anything yet
        if (!result.props?.currentBudget) {
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: true
            }));
          }
          return;
        }
        // Update only when user has made a selection
        if (result.props.currentBudget) {
          const updates = { budget: result.props.currentBudget };
          setCurrentDetails({ ...currentDetails, ...updates });
          updateSessionDetails(updates);
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: false
            }));
          }
          await append({
            role: 'user',
            content: `I've set my budget to ${result.props.currentBudget}`
          });
        }
        break;

      case 'preferenceSelector':
        // Only show selector, don't update anything yet
        if (!result.props?.currentPreferences) {
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: true
            }));
          }
          return;
        }
        // Update only when user has made a selection
        if (result.props.currentPreferences) {
          const updates = { preferences: result.props.currentPreferences };
          setCurrentDetails({ ...currentDetails, ...updates });
          updateSessionDetails(updates);
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: false
            }));
          }
          await append({
            role: 'user',
            content: `I've updated my preferences to: ${result.props.currentPreferences.join(', ')}.`
          });
        }
        break;

      case 'datePicker':
        // Only show selector, don't update anything yet
        if (!result.props?.startDate || !result.props?.endDate) {
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: true
            }));
          }
          return;
        }
        // Update only when user has made a selection
        if (result.props.startDate && result.props.endDate) {
          const updates = {
            startDate: result.props.startDate,
            endDate: result.props.endDate
          };
          setCurrentDetails({ ...currentDetails, ...updates });
          updateSessionDetails(updates);
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: false
            }));
          }
          await append({
            role: 'user',
            content: `I've changed my travel dates to ${result.props.startDate} - ${result.props.endDate}.`
          });
        }
        break;

      case 'languageSelector':
        // Only show selector, don't update anything yet
        if (!result.props?.currentLanguage) {
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: true
            }));
          }
          return;
        }
        // Update only when user has made a selection
        if (result.props.currentLanguage) {
          const updates = { language: result.props.currentLanguage };
          setCurrentDetails({ ...currentDetails, ...updates });
          updateSessionDetails(updates);
          if (toolCallId) {
            setToolVisibility(prev => ({
              ...prev,
              [toolCallId]: false
            }));
          }
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
      case 'quickResponse':
        // Keep these tools visible
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
