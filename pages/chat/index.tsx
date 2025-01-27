// pages/index.tsx
import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';
import { TravelPreference, BudgetLevel, SupportedLanguage, TravelDetails, TravelSession } from '@/managers/types';
import StageProgress from '@/components/stage-progress';
import { Place } from '@/utils/places-utils';
import { getStoredSession, initializeSession, SESSION_CONFIG, checkSessionValidity, updateLastActive, storage, getPaymentReference, setPaymentStatus, clearPaymentReference, getPaymentStatus, updateSessionLocation } from '../../utils/session-manager';
import PaymentSuccessPopup from '../../components/modals/payment-success-popup';
import PremiumUpgradeModal from '../../components/modals/premium-upgrade-modal';
import { validateStageProgression } from '../../managers/stage-manager';

const TravelChatComponent = dynamic(() => import('../../components/travel-chat'), {
    ssr: false,
})

const ItineraryPlanner = dynamic(() => import('@/components/daily-planner'), {
    ssr: false,
})

const MapComponent = dynamic(() => import('@/components/features/map-component'), {
    ssr: false,
})

type SessionData = {
    messages: any[];
    travelDetails: TravelDetails;
    savedPlaces: Place[];
    currentStage: number;
    isPaid: boolean;
};

export default function ChatPage() {
    const [apiKey, setApiKey] = useState('');
    const [apiError, setApiError] = useState('');
    const [isLoadingKey, setIsLoadingKey] = useState(true);
    const [showMap, setShowMap] = useState(true);
    const [isMobile, setIsMobile] = useState(false);
    const [isDetailsReady, setIsDetailsReady] = useState(false);
    const [travelDetails, setTravelDetails] = useState<TravelDetails>({
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
        }
    });
    const [currentStage, setCurrentStage] = useState<number>(1);
    const [isPaid, setIsPaid] = useState<boolean>(false);
    const [sessionId, setSessionId] = useState<string>('');
    const [savedPlacesUpdate, setSavedPlacesUpdate] = useState(0);
    const [showPremiumModal, setShowPremiumModal] = useState(false);
    const [showPaymentSuccess, setShowPaymentSuccess] = useState(false);

    useEffect(() => {
        // Check if we're on mobile
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 768);
            setShowMap(window.innerWidth >= 768);
        };

        // Initial check
        checkMobile();

        // Add resize listener
        window.addEventListener('resize', checkMobile);

        // Cleanup
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    useEffect(() => {
        console.log('[Index] Checking for session');
        const session = getStoredSession();
        console.log('[Index] Retrieved session from storage:', {
            hasSession: !!session,
            destination: session?.destination,
            sessionId: session?.sessionId,
            callStack: new Error().stack
        });
                
        // First check session validity
        if (!checkSessionValidity()) {
            console.error('[Index] Session is invalid or expired');
            window.location.replace('/travel-form');
            return;
        }

        // Then validate required session data
        if (!session || !session.sessionId) {
            console.error('[Index] Session ID missing');
            window.location.replace('/travel-form');
            return;
        }

        // Update lastActive timestamp
        updateLastActive();
        setSessionId(session.sessionId as string);

        // Then validate session data
        if (!session.destination || !session.startDate || !session.endDate || 
            !session.preferences || !session.preferences.length || 
            !session.startTime || 
            !session.lastActive || !session.expiresAt) {
            console.error('[Index] Invalid session data:', {
                hasDestination: !!session?.destination,
                hasStartDate: !!session?.startDate,
                hasEndDate: !!session?.endDate,
                preferencesLength: session?.preferences?.length,
                hasStartTime: !!session?.startTime,
                hasLastActive: !!session?.lastActive,
                hasExpiresAt: !!session?.expiresAt,
                callStack: new Error().stack
            });
            window.location.replace('/travel-form');
            return;
        }

        const travelDetails = {
            destination: session.destination,
            startDate: session.startDate,
            endDate: session.endDate,
            preferences: session.preferences,
            budget: session.budget || '',
            language: session.language || '',
            transport: session.transport || []
        };
        
        console.log('[Index] Setting travel details:', travelDetails);
        setTravelDetails(travelDetails);
        setIsDetailsReady(true);
        setCurrentStage(session.currentStage);
        setIsPaid(session.isPaid);

        // Then trigger Maps API key fetch if needed
        if (!apiKey && !isLoadingKey) {
            setIsLoadingKey(true); // Only set if we're not already loading
        }
    }, []);

    useEffect(() => {
        const fetchMapKey = async () => {
            try {
                console.log('[Index] Fetching Maps API key...');
                // Add cache-control headers and explicit API path
                const response = await fetch('/api/maps-key', {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    },
                    // Add cache busting and explicit next handling
                    cache: 'no-store',
                    next: { revalidate: 0 }
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();
                if (!data.key) {
                    throw new Error('No API key in response');
                }
                
                console.log('[Index] Successfully fetched Maps API key');
                setApiKey(data.key);
            } catch (error) {
                console.error('[Index] Error fetching Maps API key:', error);
                setApiError('Failed to load Google Maps');
            } finally {
                setIsLoadingKey(false);
            }
        };
        
        if (!isLoadingKey || apiKey || !sessionId) return;

        fetchMapKey();
    }, [isLoadingKey, apiKey, sessionId]);

    useEffect(() => {
        if (!travelDetails.destination || !apiKey || !isDetailsReady) return;

        const fetchCoordinates = async () => {
            try {
                const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(travelDetails.destination as string)}&key=${apiKey}`);
                if (!res.ok) {
                    throw new Error(`Failed to fetch coordinates: ${res.status}`);
                }
                const data = await res.json();
                console.log('Geocoding API Response:', data);
                
                if (data.results && data.results.length > 0) {
                    const location = data.results[0].geometry.location;
                    console.log('Parsed Location:', location);
                    
                    // Update both travel details and session
                    const newLocation = {
                        latitude: location.lat,
                        longitude: location.lng
                    };
                    
                    setTravelDetails(prevDetails => ({
                        ...prevDetails,
                        location: newLocation
                    }));
                    
                    // Store location in session
                    updateSessionLocation(newLocation);
                }
            } catch (error) {
                console.error('Error fetching coordinates:', error);
            }
        };

        fetchCoordinates();
    }, [travelDetails.destination, apiKey, isDetailsReady]);

    useEffect(() => {
        (window as any).setShowPaymentSuccess = setShowPaymentSuccess;
        (window as any).setCurrentStage = setCurrentStage;
    }, []);

    const handlePlaceRemoved = (placeId: string) => {
        console.log('Place removed:', placeId);
        setSavedPlacesUpdate(prev => prev + 1);
    };

    return (
        <div className="flex flex-col h-[100vh] w-full bg-white">
            {/* Progress tracker - fixed height */}
            <div className="flex-none">
                <StageProgress 
                    currentStage={currentStage} 
                    isPaid={isPaid}
                />
            </div>
            {/* Main content - takes remaining height */}
            <main className="flex-1 flex relative bg-white min-h-0">
                {/* Chat Interface */}
                <div className={`${isMobile ? 'w-full' : 'w-[50%]'} h-full border-r border-gray-200 overflow-y-auto`}>
                    {isDetailsReady ? (
                        <>
                            {currentStage < 4 && (
                                <TravelChatComponent 
                                    initialDetails={travelDetails} 
                                    onPlaceRemoved={handlePlaceRemoved}
                                    currentStage={currentStage}
                                    onStageUpdate={setCurrentStage}
                                />
                            )}
                            {currentStage === 4 && (
                                <ItineraryPlanner 
                                    onPlaceRemoved={handlePlaceRemoved}
                                />
                            )}
                        </>
                    ) : (
                        <div className="flex items-center justify-center h-full">
                            <p className="text-gray-500">Loading travel details...</p>
                        </div>
                    )}
                </div>

                {/* Map Toggle Button (Mobile Only) */}
                {isMobile && (
                    <button
                        onClick={() => setShowMap(!showMap)}
                        className="fixed top-16 right-4 z-50 bg-white p-2 rounded-full shadow-lg"
                    >
                        {showMap ? 'Hide Map' : 'Show Map'}
                    </button>
                )}

                {/* Map Container */}
                {(showMap || !isMobile) && (
                    <div className={`${isMobile ? 'absolute inset-0 z-40' : 'w-[50%]'}`}>
                        {apiKey ? (
                                <MapComponent
                                    city={travelDetails.destination || ''}
                                    apiKey={apiKey}
                                    key={`map-${savedPlacesUpdate}`}
                                />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <p className="text-red-500">{apiError || 'Loading map...'}</p>
                            </div>
                        )}
                    </div>
                )}
            </main>
            <PaymentSuccessPopup
                isOpen={showPaymentSuccess}
                onClose={() => setShowPaymentSuccess(false)}
                title="Hurray!"
                description="You have successfully completed your payment. Let's continue planning your perfect trip!"
            />
            {showPremiumModal && (
                <PremiumUpgradeModal 
                    isOpen={showPremiumModal} 
                    onClose={() => setShowPremiumModal(false)}
                />
            )}
        </div>
    );
}
