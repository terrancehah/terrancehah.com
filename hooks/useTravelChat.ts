import { useChat } from 'ai/react';
import { useCallback, useRef, useEffect, useState, useMemo } from 'react';
import { TravelDetails, TravelSession } from '../managers/types';
import { Place, savedPlacesManager } from '../utils/places-utils';
import { STAGE_LIMITS, validateStageProgression } from '../managers/stage-manager';
import { Message as LocalMessage, ToolInvocation } from '../managers/types';
import { Message as AiMessage } from 'ai';
import { getStoredSession, SESSION_CONFIG } from '../utils/session-manager';

interface ChatRequestBody {
  message: string;
  destination: string;
  messageCount: number;
  currentStage: number;
  metrics: TravelSession;
}

interface UseTravelChatProps {
  currentDetails: TravelDetails;
  savedPlaces: Place[];
  currentStage: number;
  metrics: TravelSession;
}

export function useTravelChat({
  currentDetails,
  savedPlaces: initialSavedPlaces,
  currentStage,
  metrics
}: UseTravelChatProps) {
  const quickResponseInProgress = useRef(false);
  const [mainChatMessages, setMainChatMessages] = useState<LocalMessage[]>([]);

  // Simply use savedPlacesManager directly
  const currentSavedPlaces = savedPlacesManager.getPlaces();
  // console.log('[useTravelChat] Current saved places:', currentSavedPlaces.map(p => ({
  //   id: p.id,
  //   photos: p.photos
  // })));

  useEffect(() => {
    const handlePlacesChanged = () => {
      // Force re-render when places change
      setMainChatMessages(prev => [...prev]);
    };

    window.addEventListener('savedPlacesChanged', handlePlacesChanged);
    return () => window.removeEventListener('savedPlacesChanged', handlePlacesChanged);
  }, []);

  const mainChat = useChat({
    api: '/api/chat',
    id: SESSION_CONFIG.STORAGE_KEY,
    body: {
      currentDetails,
      destination: currentDetails.destination, // Explicitly include destination
      savedPlaces: currentSavedPlaces
        ?.filter(place => place && place.id && place.displayName)
        ?.map(place => ({
          id: place.id,
          displayName: place.displayName,
          formattedAddress: place.formattedAddress,
          location: place.location,
          primaryType: place.primaryType,
          primaryTypeDisplayName: place.primaryTypeDisplayName,
          photos: place.photos || []
        })) || [],
      currentStage,
      metrics: {
        ...metrics,
        destination: currentDetails.destination // Ensure destination is in metrics
      }
    },
    onError: useCallback((error: Error) => {
      console.error('[MainChat] Error:', error);
      console.error('[MainChat] Current state:', {
        currentDetails,
        savedPlaces: currentSavedPlaces?.map(p => ({
          id: p?.id,
          displayName: p?.displayName,
          photos: p?.photos?.length
        })),
        currentStage,
        metrics
      });
      quickResponseInProgress.current = false;
    }, [currentDetails, currentSavedPlaces, currentStage, metrics]),
    onFinish: useCallback(async (message: AiMessage) => {
      // Only trigger quick response for complete assistant messages
      if (message.role !== 'assistant' || !message.content?.trim()) return;
      
      // Prevent multiple quick response triggers
      if (quickResponseInProgress.current) return;
      
      // If it's a limit message, don't trigger quick response
      if (message.content.includes("You've reached the maximum number of places")) {
        quickResponseInProgress.current = false;
        return;
      }
      
      quickResponseInProgress.current = true;

      try {
        // Reset previous messages to ensure clean state
        await quickResponseChat.reload();
        // Add the new message
        await quickResponseChat.append(message);
      } catch (error) {
        // console.error('[QuickResponse] Error triggering quick response:', error);
        quickResponseInProgress.current = false;
      }
    }, [])
  });

  const quickResponseChat = useChat({
    api: '/api/chat/quick-response',
    id: SESSION_CONFIG.STORAGE_KEY,
    body: {
      currentDetails,
      savedPlaces: currentSavedPlaces,
      currentStage,
      metrics
    },
    onFinish: (message) => {
      // Keep loading until we have valid responses
      const hasValidResponses = message?.toolInvocations?.some(
        t => t.toolName === 'quickResponse' && 
        t.state === 'result' && 
        t.result?.props?.responses?.length > 0
      );
      if (!hasValidResponses) {
        // console.log('[QuickResponse] No valid responses in finished message');
        return;
      }
      quickResponseInProgress.current = false;
    },
    onError: useCallback((error: Error) => {
      // console.error('[QuickResponse] Error:', error);
      quickResponseInProgress.current = false;
    }, [])
  });

  useEffect(() => {
    const mappedMessages = mainChat.messages.map(msg => ({
      ...msg,
      role: msg.role === 'data' ? 'system' : msg.role
    })) as LocalMessage[];
    
    setMainChatMessages(mappedMessages);
  }, [mainChat.messages]);

  const quickResponses = useMemo(() => {
    const messages = quickResponseChat.messages;
    
    if (messages.length < 2) {
        // console.log('[QuickResponse] Waiting for API response...');
        return [];
    }

    const apiResponse = messages[messages.length - 1];
    
    // console.log('[QuickResponse] Processing API response:', {
    //     messageId: apiResponse.id,
    //     hasToolInvocations: !!apiResponse.toolInvocations,
    //     toolInvocations: apiResponse.toolInvocations?.map(t => ({
    //         name: t.toolName,
    //         state: t.state
    //     }))
    // });

    function extractQuickResponses(message: AiMessage) {
      const quickResponseInvocation = message.toolInvocations?.find(
        t => t.toolName === 'quickResponse' && t.state === 'result'
      );

      if (!quickResponseInvocation || !('result' in quickResponseInvocation)) {
          // console.log('[QuickResponse] No valid responses found in API response');
          return [];
      }

    const responses = quickResponseInvocation.result.props.responses;
    if (responses.length > 0) {
          // console.log('[QuickResponse] Got valid responses:', responses);
          return responses;
      }

      // console.log('[QuickResponse] Empty responses array');
      return [];
    }

    return extractQuickResponses(apiResponse);
}, [quickResponseChat.messages]);

  // Stage progression validation and handling
  const handleStageProgression = useCallback((nextStage: number) => {
    const { canProgress, missingRequirements, upgradeRequired } = validateStageProgression(
        currentStage,
        nextStage,
        currentDetails
    );

    if (canProgress) {
        console.log(`[Stage Progression] Moving to stage ${nextStage}`);

        if (upgradeRequired) {
            console.log('[Stage Progression] Upgrade required for stage progression');
            // You can add any upgrade-specific logic here
        }

        return {
            type: 'stageProgress',
            props: {
                nextStage,
                reason: 'Stage requirements met',
                criteria: missingRequirements
            }
        };
    }

    return {
        type: 'stageProgress',
        props: {
            nextStage: currentStage,
            reason: 'Stage requirements not met',
            criteria: missingRequirements
        }
    };
}, [currentStage, currentDetails]);

  return {
    ...mainChat,
    messages: mainChatMessages,
    quickResponses,
    isQuickResponseLoading: quickResponseInProgress.current,
    handleStageProgression
  };
}