// components/travel-chat.tsx

'use client';

import { useRef, useState, useEffect } from 'react';
import { useChat } from 'ai/react';
import { TravelDetails } from '../managers/types';
import { BudgetSelector } from '@/components/selector-components/BudgetSelector';
import { PreferenceSelector } from '@/components/selector-components/PreferenceSelector';
import { DatePicker } from '@/components/selector-components/DateSelector';
import { LanguageSelector } from '@/components/selector-components/LanguageSelector';
import { PlaceCard } from '@/components/place-components/PlaceCard';
import Carousel from '@/components/place-components/PlaceCarousel';
import HistoricalWeatherChart from '@/components/weather/historical-weather-chart';
import { ChevronUpIcon, ChevronDownIcon } from 'lucide-react';

const TravelChat = ({ initialDetails }: { initialDetails: TravelDetails }) => {
    const [isCollapsed, setIsCollapsed] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatContainerRef = useRef<HTMLDivElement>(null);
    const [currentDetails, setCurrentDetails] = useState<TravelDetails>(initialDetails);
    const [toolVisibility, setToolVisibility] = useState<Record<string, boolean>>({});

    const {
        messages,
        input,
        handleInputChange,
        handleSubmit,
        isLoading,
        error,
        reload,
        stop,
        setMessages,
        append
    } = useChat({
        api: '/api/chat',
        body: {
            currentDetails
        }
    });

    const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(false);



    // Scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Display welcome message when component mounts
    useEffect(() => {
        if (messages.length === 0) {
            setMessages([{
                id: 'welcome',
                role: 'assistant',
                content: `I'd love to help you plan your trip to ${currentDetails.destination}! How can I help you?`,
                }]);
        }
    }, []); // Empty dependency array means this runs once on mount

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

    const formatDate = (dateStr: string) => {
        if (!dateStr || dateStr.includes('undefined')) return dateStr;
        // If already in DD/MM/YYYY format, return as is
        if (dateStr.match(/^\d{2}\/\d{2}\/\d{4}$/)) return dateStr;
        // Convert from YYYY-MM-DD to DD/MM/YYYY
        const [year, month, day] = dateStr.split('-');
        return `${day}/${month}/${year}`;
    };

    // Helper function to get update messages
    const getUpdateMessage = (type: string, value: any): string => {
        switch (type) {
            case 'budgetSelector':
                return `I've updated my budget to ${value} for the trip.`;
            case 'preferenceSelector':
                return `I've updated my preferences to: ${value.join(', ')}.`;
            case 'datePicker':
                return `I've changed my travel dates to ${formatDate(value.startDate)} - ${formatDate(value.endDate)}.`;
            case 'languageSelector':
                return `I've set my language preference to ${value}.`;
            case 'weatherChart':
                return "Show me the historical weather data for this location";
            default:
                return '';
        }
    };

    // Helper function to get updated details based on tool type
    const getUpdatedDetails = (type: string, value: any): TravelDetails => {
        switch (type) {
            case 'budgetSelector':
                return { ...currentDetails, budget: value };
            case 'preferenceSelector':
                return { ...currentDetails, preferences: value };
            case 'datePicker':
                return {
                    ...currentDetails,
                    startDate: formatDate(value.startDate),
                    endDate: formatDate(value.endDate)
                };
            case 'languageSelector':
                return { ...currentDetails, language: value };
            case 'placeCard':
            case 'carousel':
            case 'weatherChart':
                // These components don't update currentDetails
                return currentDetails;
            default:
                return currentDetails;
        }
    };

    const handleToolUpdate = async (type: string, value: any, toolCallId: string, messageId: string) => {
        // Hide the tool component immediately
        setToolVisibility(prev => ({
            ...prev,
            [toolCallId]: false
        }));

        const newDetails = getUpdatedDetails(type, value);

        // Update the existing message's tool result
        setMessages(prev => prev.map(m => 
            m.id === messageId 
                ? {
                    ...m,
                    toolInvocations: m.toolInvocations?.map(t =>
                        t.toolCallId === toolCallId
                            ? { ...t, result: value }
                            : t
                    )
                }
                : m
        ));

        // Update state
        setCurrentDetails(newDetails);

        // Send update message to AI using append
        await append({
            role: 'user',
            content: getUpdateMessage(type, value)
        });
    };

    // Helper function to get preset messages for quick buttons
    const getQuickMessage = (type: string): string => {
        switch (type) {
            case 'budgetSelector':
                return "I'd like to update my budget for the trip";
            case 'preferenceSelector':
                return "I want to change my travel preferences";
            case 'datePicker':
                return "I need to adjust my travel dates";
            case 'languageSelector':
                return "I want to change the language setting";
            case 'weatherChart':
                return "Show me the historical weather data for this location";
            default:
                return '';
        }
    };

    // Quick button handler - directly sends message to AI
    const handleQuickButton = async (type: string) => {
        
        const message = getQuickMessage(type);
        await append({
            role: 'user',
            content: message,
        });
    };

    return (

        <div className="flex flex-col h-[100vh]">

            {/* Header */}
            <div className="bg-background border-b border-border transition-all duration-300 ease-in-out">
                <div className=" mx-auto p-4 px-6 relative">
                    <div 
                        className={` transition-all duration-300 ease-in-out ${
                            isCollapsed ? 'max-h-36' : 'max-h-[500px]'
                        }`}
                    >
                        <h1 className="text-2xl font-semibold text-foreground mb-2">
                            Trip to {currentDetails.destination}
                        </h1>
                        
                        {isCollapsed ? (

                            // Collapsed mode
                            <div className="flex flex-col gap-y-1.5 text-muted-foreground mb-4">
                                
                                {/* <div className="flex gap-x-16 text-left">
                                    <div className="text-base">
                                        {currentDetails.startDate} - {currentDetails.endDate}
                                    </div>
                                    <div className="text-base">
                                        {currentDetails.language}
                                    </div>
                                    <div className="text-base">
                                        {currentDetails.budget}
                                    </div>
                                </div>
                                
                                <div className="flex gap-x-10 text-left">
                                    <div className="text-base">
                                        {currentDetails.preferences?.join(', ')}
                                    </div>
                                    
                                </div> */}
                                
                            </div>
                        ) : (

                            // Expanded mode
                            <div className="grid grid-cols-2 gap-x-16 gap-y-4">
                                <div>
                                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                                        </svg>
                                        Date
                                    </div>
                                    <div className="text-foreground">{currentDetails.startDate} to {currentDetails.endDate}</div>
                                </div>
                                <div>
                                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                                        </svg>
                                        Language
                                    </div>
                                    <div className="text-foreground">{currentDetails.language}</div>
                                </div>
                                
                                <div>
                                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                                        </svg>
                                        Preferences
                                    </div>
                                    <div className="text-foreground">
                                        {currentDetails.preferences?.join(', ') || '-'}
                                    </div>
                                </div>
                                <div>
                                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                        </svg>
                                        Budget
                                    </div>
                                    <div className="text-foreground">
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
            <div className="flex-1 overflow-y-auto" ref={chatContainerRef}>
                <div className="flex gap-3 flex-col p-4">
                    

                    {messages.map((message) => {

                        // Filter visible tools first
                        const visibleTools = message.toolInvocations?.filter(t => toolVisibility[t.toolCallId]) || [];

                        // If this message only had tools (no content) and all tools are now hidden, skip rendering
                        if (!message.content && message.toolInvocations && message.toolInvocations.length > 0 && visibleTools.length === 0) {
                            return null;
                        }
                        
                        return (
                            <div key={message.id} className="w-full flex flex-col gap-3">
                                {message.content && (
                                    <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`${
                                            message.role === 'user' 
                                                ? 'bg-blue-500 text-white rounded-br-none' 
                                                : 'bg-gray-200 text-gray-700 rounded-bl-none'
                                        } rounded-2xl px-4 py-2 max-w-[80%]`}>
                                            <p>{message.content}</p>
                                        </div>
                                    </div>
                                )}

                                {visibleTools.map((toolInvocation) => {
                                    const { toolName, toolCallId, state } = toolInvocation;

                                    if (state === 'result') {
                                        switch (toolName) {
                                            case 'budgetSelector':
                                                if(!toolInvocation.result?.props) return null;
                                                return (
                                                    <div key={toolCallId} className="flex justify-start">
                                                        <div className="w-full">
                                                            <BudgetSelector 
                                                                {...toolInvocation.result.props}
                                                                budget={currentDetails.budget}
                                                                onUpdate={(value) => handleToolUpdate('budgetSelector', value, toolCallId, message.id)}
                                                            />
                                                        </div>
                                                    </div>
                                                );

                                            case 'preferenceSelector':
                                                if(!toolInvocation.result) return null;
                                                return (
                                                    <div key={toolCallId} className="flex justify-start">
                                                        <div className="w-full">
                                                            <PreferenceSelector 
                                                                {...toolInvocation.result.props}
                                                                currentPreferences={currentDetails.preferences}
                                                                onUpdate={(value) => handleToolUpdate('preferenceSelector', value, toolCallId, message.id)}
                                                            />
                                                        </div>
                                                    </div>
                                                );

                                            case 'datePicker':
                                                if(!toolInvocation.result?.props) return null;
                                                return (
                                                    <div key={toolCallId} className="flex justify-start">
                                                        <div className="w-full">
                                                            <DatePicker 
                                                                {...toolInvocation.result.props}
                                                                dates={{
                                                                    startDate: currentDetails.startDate,
                                                                    endDate: currentDetails.endDate
                                                                }}
                                                                onUpdate={(value) => handleToolUpdate('datePicker', value, toolCallId, message.id)}
                                                            />
                                                        </div>
                                                    </div>
                                                );

                                            case 'languageSelector':
                                                if(!toolInvocation.result?.props) return null;
                                                return (
                                                    <div key={toolCallId} className="flex justify-start">
                                                        <div className="w-full">
                                                            <LanguageSelector 
                                                                {...toolInvocation.result.props}
                                                                language={currentDetails.language}
                                                                onUpdate={(value) => handleToolUpdate('languageSelector', value, toolCallId, message.id)}
                                                            />
                                                        </div>
                                                    </div>
                                                );

                                            case 'placeCard':
                                                if(!toolInvocation.result?.props?.place) return null;
                                                return (
                                                    <div key={toolCallId} className="flex justify-start">
                                                        <div className="w-full">
                                                            {toolInvocation.result?.props?.place && (
                                                                <PlaceCard
                                                                    place={toolInvocation.result.props.place}
                                                                    showActions={false}
                                                                    onSelect={(place) => handleToolUpdate('placeCard', { selectedPlace: place }, toolCallId, message.id)}
                                                                />
                                                            )}
                                                        </div>
                                                    </div>
                                                );

                                            case 'carousel':
                                                if(!toolInvocation.result?.props) return null;
                                                return (
                                                    <div key={toolCallId} className="flex justify-start">
                                                        <div className="w-full">
                                                            {toolInvocation.result?.props?.places && toolInvocation.result.props.places.length > 0 && (
                                                                <Carousel 
                                                                    places={toolInvocation.result.props.places}
                                                                />
                                                            )}
                                                        </div>
                                                    </div>
                                                );

                                                case 'weatherChart':
                                                    if(!toolInvocation.result?.props) return null;
                                                    return (
                                                        <div key={toolCallId} className="flex justify-start">
                                                            <div className="w-full">
                                                                <HistoricalWeatherChart 
                                                                    lat={toolInvocation.result.props.lat}
                                                                    lon={toolInvocation.result.props.lon}
                                                                    startDate={toolInvocation.result.props.startDate}
                                                                    endDate={toolInvocation.result.props.endDate}
                                                                    city={toolInvocation.result.props.city}
                                                                    units={toolInvocation.result.props.units}
                                                                />
                                                            </div>
                                                        </div>
                                                    );

                                            default:
                                                return null;
                                        }
                                    } else {
                                        return (
                                            <div key={toolCallId}>
                                                <div>Loading {toolName}...</div>
                                            </div>
                                        );
                                    }
                                })}
                            </div>
                        );
                    })}

                    {/* Error display */}
                    {error && (
                        <div className="p-3 bg-red-50 rounded-lg">
                            <p className="text-red-600 text-sm">{error.toString()}</p>
                            <button 
                                onClick={(e) => {
                                    e.preventDefault();
                                    reload();
                                }} 
                                className="text-sm text-red-700 hover:text-red-800 underline"
                            >
                                Try Again
                            </button>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>
            </div>

            {/* Quick Buttons Container */}
            <div className="flex flex-col xl:flex-row gap-2.5 px-4 py-3 bg-white">
                <div className="flex flex-row gap-2.5">

                    {/* Dates */}
                    <button
                        onClick={() => handleQuickButton('datePicker')}
                        className="flex px-3 py-2 text-sm text-gray-600 hover:text-gray-900 bg-light-blue hover:bg-blue-200 hover:shadow-sm rounded-2xl transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                        </svg> Dates
                    </button>

                    {/* Budget */}
                    <button
                        onClick={() => handleQuickButton('budgetSelector')}
                        className="flex px-3 py-2 text-sm text-gray-600 hover:text-gray-900 bg-light-blue hover:bg-blue-200 hover:shadow-sm rounded-2xl transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg> Budget
                    </button>
                </div>

                <div className="flex flex-row gap-2.5">

                    {/* Preferences */}
                    <button
                        onClick={() => handleQuickButton('preferenceSelector')}
                        className="flex px-3 py-2 text-sm text-gray-600 hover:text-gray-900 bg-light-blue hover:bg-blue-200 hover:shadow-sm rounded-2xl transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                        </svg> Preferences
                    </button>

                    {/* Language */}
                    <button
                        onClick={() => handleQuickButton('languageSelector')}
                        className="flex px-3 py-2 text-sm text-gray-600 hover:text-gray-900 bg-light-blue hover:bg-blue-200 hover:shadow-sm rounded-2xl transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                        </svg> Language
                    </button>


                    <button
                        onClick={() => handleQuickButton('weatherChart')}
                        className="flex px-3 py-2 text-sm text-gray-600 hover:text-gray-900 bg-light-blue hover:bg-blue-200 hover:shadow-sm rounded-2xl transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                        </svg> Weather
                    </button>
                </div>
            </div>

            <div className="border-t border-gray-200 px-4 py-4 sm:mb-0 bg-white">
                <form onSubmit={handleSubmit} className="flex space-x-4">
                    <input
                        type="text"
                        value={input}
                        onChange={handleInputChange}
                        placeholder="Type your message..."
                        className="flex-1 rounded-md border border-gray-300 px-4 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        disabled={isLoading}
                    />
                    {isLoading && (
                        <button
                            onClick={stop}
                            className="inline-flex items-center rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                        >
                            Stop
                        </button>
                    )}
                    <button
                        type="submit"
                        disabled={isLoading}
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