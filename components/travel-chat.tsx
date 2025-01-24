// components/travel-chat.tsx

'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { BudgetLevel, SupportedLanguage, TravelDetails, TravelPreference, WeatherChartProps } from '../managers/types';
import { BudgetSelector } from './selectors/BudgetSelector';
import { PreferenceSelector } from './selectors/PreferenceSelector';
import { DatePicker } from './selectors/DateSelector';
import { LanguageSelector } from './selectors/LanguageSelector';
import { PlaceCard } from './features/places/PlaceCard';
import { Carousel } from './features/places/PlaceCarousel';
import { SavedPlacesList } from './features/places/SavedPlacesList';
import HistoricalWeatherChart from './features/weather/historical-weather-chart';
import { ChevronUpIcon, ChevronDownIcon } from 'lucide-react';
import { QuickResponse } from './chat/QuickResponse';
import ReactMarkdown from 'react-markdown';
import { validateStageProgression } from '../managers/stage-manager';
import { TravelSession, StageProgressResult } from '../managers/types';
import { CurrencyConverter } from './features/currency/CurrencyConverter';
import { useTravelChat } from '../hooks/useTravelChat';
import { useTravelTools } from '../hooks/useTravelTools';
import { Place, savedPlacesManager, searchPlaceByText } from '../utils/places-utils';
import { ToolInvocation } from '../managers/types';
import { getStoredSession, checkInputLimits, handleSessionExpiry, checkSessionWithWarning, updateStoredMetrics } from '../utils/session-manager';
import PremiumUpgradeModal from './modals/premium-upgrade-modal';
import SessionWarningModal from './modals/session-warning-modal';
import { useRouter } from 'next/router';

interface TravelChatProps {
    initialDetails: TravelDetails;
    onPlaceRemoved: (placeId: string) => void;
    currentStage: number;
    onStageUpdate: (nextStage: number) => void;
}

export function TravelChat({ 
    initialDetails, 
    onPlaceRemoved, 
    currentStage,
    onStageUpdate 
}: TravelChatProps) {
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatContainerRef = useRef<HTMLDivElement>(null);
    const [currentDetails, setCurrentDetails] = useState<TravelDetails>(initialDetails);
    const router = useRouter();
    const [sessionMetadata] = useState<TravelSession | null>(() => {
        return getStoredSession();
    });

    // Handle missing session
    useEffect(() => {
        if (!sessionMetadata) {
            router.push('/travel-form');
        }
    }, [sessionMetadata, router]);

    // Return early if no session
    if (!sessionMetadata) {
        return null;
    }

    const [isCollapsed, setIsCollapsed] = useState(true);

    useEffect(() => {
        const handlePlacesChanged = (event: Event) => {
            if (!(event instanceof CustomEvent)) return;
            
            // Safely get count from event detail or fallback to savedPlacesManager
            const count = event.detail?.count ?? savedPlacesManager.places.size;
            
            console.log('[TravelChat] Places changed:', { 
                count,
                fromEvent: event.detail,
                fromManager: savedPlacesManager.places.size 
            });
            
            setCurrentDetails(prev => ({
                ...prev,
                savedPlacesCount: count
            }));
        };

        // Listen for changes
        window.addEventListener('savedPlacesChanged', handlePlacesChanged);

        // Initial load
        const initialCount = savedPlacesManager.places.size;
        console.log('[TravelChat] Initial places load count:', initialCount);
        
        setCurrentDetails(prev => ({
            ...prev,
            savedPlacesCount: initialCount
        }));

        return () => {
            window.removeEventListener('savedPlacesChanged', handlePlacesChanged);
        };
    }, []);

    const {
        messages,
        isLoading,
        append,
        reload,
        input,
        setInput,
        handleInputChange,
        handleSubmit,
        stop,
        quickResponses,
        isQuickResponseLoading,
        showSessionWarning,
        setShowSessionWarning,
        isWithinStageLimit,
        showPremiumModal,
        setShowPremiumModal
    } = useTravelChat({
        currentDetails,
        currentStage,
        savedPlaces: savedPlacesManager.getPlaces(),
        metrics: sessionMetadata
    });

    const {
        toolVisibility,
        setToolVisibility,
        handleToolUpdate
    } = useTravelTools({
        currentDetails,
        setCurrentDetails,
        currentStage,
        onStageUpdate,
        append,
        savedPlaces: savedPlacesManager.getPlaces(),
        userMetrics: sessionMetadata
    });

    // Add ref to track processed messages
    const processedMessages = useRef(new Set<string>());

    // Extract quick response options
    const getQuickResponseOptions = useCallback(() => {
        return quickResponses || [];
    }, [quickResponses]);

   // Function to check if quick responses should be shown
    const shouldShowQuickResponses = useCallback(() => {
        // Don't show quick responses if any parameter component is active
        const hasActiveParameterComponent = messages.some(message => 
            message.toolInvocations?.some(t => 
                ['budgetSelector', 'preferenceSelector', 'datePicker', 'languageSelector'].includes(t.toolName)
                && toolVisibility[t.toolCallId] // Check if the component is visible
            )
        );
        
        if (hasActiveParameterComponent) {
            // console.log('[QuickResponse] Hidden due to active parameter component');
            return false;
        }

        // Show quick responses if we have valid options
        return !isLoading && (quickResponses?.length > 0 || isQuickResponseLoading);
    }, [messages, toolVisibility, quickResponses, isLoading, isQuickResponseLoading]);

    // Scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const initialMessageSent = useRef(false);

    // Modified initial load effect
    useEffect(() => {
        if (!initialMessageSent.current && messages.length === 0) {
            initialMessageSent.current = true;
            const body = {
                currentDetails,
                savedPlaces: savedPlacesManager.getPlaces(),
                currentStage
            };
            
            append({
                role: 'user',
                content: `I'm travelling to ${currentDetails.destination} from ${currentDetails.startDate} to ${currentDetails.endDate}. 
                Can you help me plan my trip?`,
            }, { body });
        }
    }, [currentDetails, currentStage]);

    // Set new tool invocations to visible
    useEffect(() => {
        const newToolVisibility: Record<string, boolean> = {};
        messages.forEach(message => {
            message.toolInvocations?.forEach(tool => {
                if (!(tool.toolCallId in toolVisibility)) {
                    newToolVisibility[tool.toolCallId] = true;
                }
            });
        });
        
        if (Object.keys(newToolVisibility).length > 0) {
            setToolVisibility(prev => ({
                ...prev,
                ...newToolVisibility
            }));
        }
    }, [messages]);

    // Add stage progression handling
    useEffect(() => {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === 'assistant' && lastMessage.toolInvocations) {
            lastMessage.toolInvocations.forEach((toolInvocation) => {
                if (toolInvocation.toolName === 'stageProgress' && 'result' in toolInvocation) {
                    const result = toolInvocation.result as StageProgressResult;
                    
                    if (validateStageProgression(
                        currentStage,
                        result.props.nextStage,
                        currentDetails
                    )) {
                        onStageUpdate(result.props.nextStage);
                    }
                }
            });
        }
    }, [messages, onStageUpdate, currentStage]);

    // const formatDate = (dateStr: string) => {
    //     if (!dateStr || dateStr.includes('undefined')) return dateStr;
    //     // If already in DD/MM/YYYY format, return as is
    //     if (dateStr.match(/^\d{2}\/\d{2}\/\d{4}$/)) return dateStr;
    //     // Convert from YYYY-MM-DD to DD/MM/YYYY
    //     const [year, month, day] = dateStr.split('-');
    //     return `${day}/${month}/${year}`;
    // };

    // Function to handle quick response selection
    const handleQuickResponseSelect = async (text: string) => {
        try {
            // Check for stage 3 prompt limit
            if (currentStage === 3 && !sessionMetadata.isPaid && !isWithinStageLimit) {
                setShowPremiumModal(true);
                return;
            }

            // Check if it's a place search request
            if (text.toLowerCase().includes('add') && text.toLowerCase().includes('park')) {
                const searchText = 'park';
                if (currentDetails.destination) {
                    const place = await searchPlaceByText(
                        searchText,
                        { latitude: 1.3521, longitude: 103.8198 }, // Singapore coordinates
                        currentDetails.destination
                    );
                    if (place) {
                        console.log('[handleQuickResponseSelect] Successfully found place:', place.id);
                    }
                }
            }

            // Send the response to chat
            const body = {
                message: text,
                currentDetails,
                destination: currentDetails.destination,
                messageCount: messages.length,
                currentStage,
                metrics: sessionMetadata
            };
            
            await append({
                role: 'user',
                content: text
            }, { body });
        } catch (error) {
            console.error('[handleQuickResponseSelect] Error:', error);
        }
    };

    // We need to wrap handleSubmit to include our body data
    const handleMessageSubmit = async (e: React.FormEvent<HTMLFormElement>, text?: string) => {
        e?.preventDefault();
        if (!input && !text) return;

        const messageText = text || input;
        // Clear input immediately before sending
        setInput('');

        try {
            // Prepare body with latest state
            const body = {
                currentDetails,
                savedPlaces: savedPlacesManager.getPlaces(),
                currentStage,
                metrics: sessionMetadata
            };
            
            console.log('[handleMessageSubmit] Sending message with body:', body);
            
            // Send message to main chat
            await append({
                role: 'user',
                content: messageText
            }, { body });
        } catch (error) {
            console.error('[handleMessageSubmit] Error:', error);
            console.error('[handleMessageSubmit] Current state:', {
                currentDetails,
                savedPlacesCount: savedPlacesManager.getPlaces().length,
                currentStage,
                metrics: sessionMetadata
            });
        }
    };

    // Update stage validation
    const validateStageProgress = (nextStage: number): boolean => {
        const validationResult = validateStageProgression(
            currentStage,
            nextStage,
            currentDetails
        );

        if (!validationResult.canProgress) {
            return false;
        }

        return true;
    };

    // // Function to check if any parameter component is active
    // const isParameterComponentActive = () => {
    //     return messages.some(message => {
    //         const toolInvocations = message.toolInvocations || [];
    //         return toolInvocations.some(tool => {
    //             const type = tool.toolName;
    //             // Check if it's a parameter component type AND if it's visible in the toolVisibility state
    //             return (type === 'budgetSelector' || 
    //                 type === 'preferenceSelector' || 
    //                 type === 'datePicker' || 
    //                 type === 'languageSelector') &&
    //                 toolVisibility[tool.toolCallId] // Check if the component is visible
    //         });
    //     });
    // };

    const mainChat = useTravelChat({
        currentDetails,
        currentStage,
        savedPlaces: savedPlacesManager.getPlaces(),
        metrics: sessionMetadata
    });

    useEffect(() => {
        const handleFinish = async (message: any) => {
            // Process message here
        };

        // Check if last message exists and process it
        const lastMessage = mainChat.messages[mainChat.messages.length - 1];
        if (lastMessage) {
            handleFinish(lastMessage).catch(console.error);
        }
    }, [mainChat, currentDetails, currentStage, onStageUpdate]);

    return (
        <div className="relative flex flex-col h-full">
            <PremiumUpgradeModal 
                isOpen={showPremiumModal} 
                onClose={() => setShowPremiumModal(false)} 
            />
            <SessionWarningModal 
                isOpen={showSessionWarning}
                onClose={() => setShowSessionWarning(false)}
            />
            {/* Header */}
            <div className="bg-background border-b border-border shadow-sm transition-all duration-300 ease-in-out">
                <div className=" mx-auto p-2 px-6 relative">
                    <div 
                        className={`transition-all duration-300 ease-in-out ${
                            isCollapsed ? 'max-h-12' : 'max-h-[500px]'
                        }`}
                    >
                        <h1 className={`font-semibold text-foreground ${isCollapsed ? 'text-lg mb-0' : 'text-lg mb-2'}`}>
                            Trip to {currentDetails.destination}
                        </h1>
                        
                        {isCollapsed ? (

                            // Collapsed mode
                            <div className="flex flex-col gap-y-1.5 text-muted-foreground">
                                {/* Keeping this empty as requested */}
                            </div>
                        ) : (

                            // Expanded mode
                            <div className="grid grid-cols-2 gap-x-16 gap-y-4">

                                {/* Date */}
                                <div>
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                                        </svg>
                                        Date
                                    </div>
                                    <div className="text-foreground text-sm">{currentDetails.startDate} to {currentDetails.endDate}</div>
                                </div>

                                <div>
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                                        </svg>
                                        Language
                                    </div>
                                    <div className="text-foreground text-sm">{currentDetails.language}</div>
                                </div>
                                
                                <div>
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                                        </svg>
                                        Preferences
                                    </div>
                                    <div className="text-foreground text-sm">
                                        {currentDetails.preferences?.join(', ') || '-'}
                                    </div>
                                </div>
                                <div>
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                        </svg>
                                        Budget
                                    </div>
                                    <div className="text-foreground text-sm">
                                        {currentDetails.budget || '-'}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                    <button
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        className="absolute bottom-0 left-1/2 transform -translate-x-1/2 px-2 py-0.5 mb-2 text-gray-500 hover:text-black hover:bg-slate-200 transition-colors bg-slate-50 rounded-full duration-200 focus:outline-none"
                        aria-label={isCollapsed ? "Expand header" : "Collapse header"}
                    >
                        {isCollapsed ? (
                            <ChevronDownIcon className="h-6 w-6" />
                        ) : (
                            <ChevronUpIcon className="h-6 w-6" />
                        )}
                    </button>
                </div>
            </div>

            {/* Chat Messages Container */}
            <div 
                ref={chatContainerRef}
                className={`flex-grow overflow-y-auto py-4 transition-all duration-300 ease-in-out 
                }`}
            >
                <div className="space-y-4 px-4">
                    {messages.map((message, index) => (
                        <div key={index} className="w-full flex flex-col gap-3">
                            {/* Message content */}
                            {message.content && (
                                <div key={`content-${message.id || index}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`${
                                        message.role === 'user' 
                                            ? 'bg-blue-500 text-white rounded-br-none w-min min-w-[35%]' 
                                            : 'bg-gray-200 text-gray-700 rounded-bl-none w-[75%]'
                                    } rounded-2xl px-4 py-2 max-w-[75%]`}>
                                        <ReactMarkdown 
                                            className="prose max-w-none"
                                            components={{
                                                h1: ({node, ...props}) => <h1 className="text-lg font-bold" {...props} />,
                                                h2: ({node, ...props}) => <h2 className="text-base font-semibold" {...props} />,
                                                h3: ({node, ...props}) => <h3 className="text-sm font-medium" {...props} />,
                                                p: ({node, ...props}) => <p className="text-sm" {...props} />,
                                                ul: ({node, ...props}) => <ul className="list-disc ml-4 mb-1" {...props} />,
                                                li: ({node, ...props}) => <li className="text-sm mb-0.5" {...props} />,
                                            }}
                                        >
                                            {message.content}
                                        </ReactMarkdown>
                                    </div>
                                </div>
                            )}
                            {message.toolInvocations?.map((toolInvocation, index) => {
                                const { toolName, toolCallId, state } = toolInvocation;

                                // Only render if the tool is visible in toolVisibility state
                                if (!toolVisibility[toolCallId]) return null;

                                if (state === 'result') {
                                    switch (toolName) {
                                        case 'budgetSelector':
                                            if(!toolInvocation.result?.props) return null;
                                            const budgetProps = toolInvocation.result.props as { currentBudget: BudgetLevel };
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        <BudgetSelector 
                                                            currentBudget={budgetProps.currentBudget}
                                                            onUpdate={(budget) => {
                                                                const result = {
                                                                    type: 'budgetSelector',
                                                                    props: { currentBudget: budget }
                                                                };
                                                                handleToolUpdate({ 
                                                                    toolInvocations: [{
                                                                        toolCallId,
                                                                        toolName,
                                                                        result
                                                                    }]
                                                                });
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            );

                                        case 'preferenceSelector':
                                            if(!toolInvocation.result?.props) return null;
                                            const prefProps = toolInvocation.result.props as { currentPreferences: TravelPreference[] };
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        {toolVisibility[toolCallId] && (
                                                            <PreferenceSelector 
                                                                currentPreferences={prefProps.currentPreferences}
                                                                onUpdate={(preferences) => {
                                                                    const result = {
                                                                        type: 'preferenceSelector',
                                                                        props: { currentPreferences: preferences }
                                                                    };
                                                                    handleToolUpdate({ 
                                                                        toolInvocations: [{
                                                                            toolCallId,
                                                                            toolName,
                                                                            result
                                                                        }]
                                                                    });
                                                                }}
                                                            />
                                                        )}
                                                    </div>
                                                </div>
                                            );

                                        case 'datePicker':
                                            if(!toolInvocation.result?.props) return null;
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        <DatePicker 
                                                            dates={{
                                                                startDate: currentDetails.startDate || '',
                                                                endDate: currentDetails.endDate || ''
                                                            }}
                                                            onUpdate={(dates) => {
                                                                const result = {
                                                                    type: 'datePicker',
                                                                    props: dates
                                                                };
                                                                handleToolUpdate({ 
                                                                    toolInvocations: [{
                                                                        toolCallId,
                                                                        toolName,
                                                                        result
                                                                    }]
                                                                });
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            );

                                        case 'languageSelector':
                                            if(!toolInvocation.result?.props) return null;
                                            const langProps = toolInvocation.result.props as { currentLanguage: SupportedLanguage };
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        <LanguageSelector 
                                                            currentLanguage={langProps.currentLanguage}
                                                            onUpdate={(language) => {
                                                                const result = {
                                                                    type: 'languageSelector',
                                                                    props: { currentLanguage: language }
                                                                };
                                                                handleToolUpdate({ 
                                                                    toolInvocations: [{
                                                                        toolCallId,
                                                                        toolName,
                                                                        result
                                                                    }]
                                                                });
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            );

                                        case 'placeCard':
                                            if(!toolInvocation.result?.props?.place) return null;
                                            const placeProps = toolInvocation.result.props as { place: Place };
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        {placeProps.place && (
                                                            <PlaceCard
                                                                place={placeProps.place}
                                                                showActions={false}
                                                                onSelect={() => {}}
                                                            />
                                                        )}
                                                    </div>
                                                </div>
                                            );

                                        case 'carousel':
                                            if(!toolInvocation.result?.props?.places) return null;
                                            const carouselProps = toolInvocation.result.props as { places: Place[] };
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        {carouselProps.places.length > 0 && (
                                                            <Carousel 
                                                                places={carouselProps.places}
                                                            />
                                                        )}
                                                    </div>
                                                </div>
                                            );

                                        case 'weatherChart':
                                            if(!toolInvocation.result?.props) return null;
                                            const weatherProps = toolInvocation.result.props as unknown as WeatherChartProps;
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        <HistoricalWeatherChart 
                                                            {...weatherProps}
                                                        />
                                                    </div>
                                                </div>
                                            );

                                        case 'currencyConverter':
                                            if (!toolInvocation.result?.props) return null;
                                            return (
                                                <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                    <div className="w-full">
                                                        <CurrencyConverter 
                                                            {...toolInvocation.result.props}
                                                        />
                                                    </div>
                                                </div>
                                            );

                                            case 'savedPlacesList':
                                                return (
                                                    <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                                        <div className="w-full">
                                                            <SavedPlacesList
                                                                onRemove={onPlaceRemoved}
                                                            />
                                                        </div>
                                                    </div>
                                                );

                                        default:
                                            return null;
                                    }
                                } else {
                                    return (

                                        // AI Response Component Loading Placeholder
                                        <div key={`${toolCallId}-${index}`} className="flex justify-start">
                                            <div className="relative overflow-hidden min-w-[200px] 
                                            before:absolute before:inset-0 before:z-0 before:bg-gradient-to-r 
                                            before:from-blue-200 before:via-purple-300 before:to-pink-200 
                                            before:animate-gradient-x before:bg-[length:200%_100%] after:absolute after:inset-0 
                                            after:bg-white after:opacity-70 after:z-[1] shadow-sm
                                            text-secondary rounded-2xl rounded-bl-none px-4 py-1.5 max-w-[75%]">
                                                <div className="relative z-[2]">
                                                    <span className="inline-flex items-center gap-1 text-sky-blue">
                                                        <span className="text-sm">Travel-Rizz is thinking</span>
                                                        <span className="animate-[pulse_1.2s_ease-in-out_infinite]">.</span>
                                                        <span className="animate-[pulse_1.2s_ease-in-out_infinite_400ms]">.</span>
                                                        <span className="animate-[pulse_1.2s_ease-in-out_infinite_800ms]">.</span>
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                    );
                                }
                            })}
                            
                            {isLoading && message.id === messages[messages.length - 1].id && (
                                // AI Response Message Loading Placeholder
                                <div key={`loading-${message.id}`} className="flex justify-start">
                                    <div className="relative overflow-hidden min-w-[200px] 
                                            before:absolute before:inset-0 before:z-0 before:bg-gradient-to-r 
                                            before:from-blue-300 before:via-purple-400 before:to-pink-300 before: to-orange-400
                                            before:animate-gradient-x before:bg-[length:200%_100%] after:absolute after:inset-0 
                                            after:bg-white after:opacity-70 after:z-[1] shadow-sm
                                            text-secondary rounded-2xl rounded-bl-none px-4 py-1.5 max-w-[75%]">
                                        <div className="relative z-[2]">
                                            <span className="inline-flex items-center gap-1 text-sky-blue">
                                                <span className="text-sm">Travel-Rizz is thinking</span>
                                                <span className="animate-[pulse_1.2s_ease-in-out_infinite]">.</span>
                                                <span className="animate-[pulse_1.2s_ease-in-out_infinite_400ms]">.</span>
                                                <span className="animate-[pulse_1.2s_ease-in-out_infinite_800ms]">.</span>
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                    <div ref={messagesEndRef} />
                </div>
            </div>

            {/* Quick responses section - Now outside the chat container */}
            {shouldShowQuickResponses() && (
                <div className="px-4 py-2 border-gray-100">
                    <QuickResponse 
                        responses={getQuickResponseOptions()}
                        onResponseSelect={handleQuickResponseSelect}
                        isLoading={isQuickResponseLoading}
                    />
                </div>
            )}

            {/* Chat Input Container */}
            <div className="border-t border-gray-200 px-4 py-4 sm:mb-0 bg-white">
                <form onSubmit={handleMessageSubmit} className="flex space-x-4">
                    <input
                        type="text"
                        value={input}
                        onChange={handleInputChange}
                        placeholder="Type your message..."
                        className="flex-1 rounded-md border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        disabled={isLoading || !isWithinStageLimit}
                    />
                    {/* {isLoading && (
                        <button
                            onClick={stop}
                            className="inline-flex items-center rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                        >
                            Stop
                        </button>
                    )} */}
                    <button
                        type="submit"
                        disabled={isLoading || !isWithinStageLimit}
                        className="inline-flex items-center rounded-md bg-blue-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
                    >
                        Send
                    </button>
                    
                </form>
            </div>

        </div>
    );
};

export default TravelChat;