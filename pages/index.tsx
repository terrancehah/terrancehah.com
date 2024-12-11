// pages/index.tsx
import { useRouter } from 'next/router'
import dynamic from 'next/dynamic'
import { useState, useEffect } from 'react';
import { TravelPreference, BudgetLevel, SupportedLanguage, TravelDetails } from '@/managers/types';

const TravelChatComponent = dynamic(() => import('../components/travel-chat'), {
    ssr: false,
})

const MapComponent = dynamic(() => import('../components/map-component'), {
    ssr: false,
})

export default function ChatPage() {
    const [apiKey, setApiKey] = useState('');
    const [apiError, setApiError] = useState('');
    const [isLoadingKey, setIsLoadingKey] = useState(true);
    const [showMap, setShowMap] = useState(true);
    const [isMobile, setIsMobile] = useState(false);
    const [isDetailsReady, setIsDetailsReady] = useState(false);
    const [travelDetails, setTravelDetails] = useState<TravelDetails>({
        destination: undefined,
        destinationLat: undefined,
        destinationLng: undefined,
        startDate: undefined,
        endDate: undefined,
        preferences: [],
        budget: undefined,
        language: undefined,
        transport: [],
        dining: []
    });

    const router = useRouter()
    const {
        city,
        startDate,
        endDate,
        budget,
        language
    } = router.query

    // Handle array parameters separately since Next.js has special handling for them
    const preferences = router.query['travel-preference[]'] || [];

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

    // Fetch API key
    useEffect(() => {
        const fetchMapKey = async () => {
            if (!isLoadingKey) return; // Prevent duplicate fetches if we're not in loading state
            
            try {
                console.log('Fetching Maps API key...');
                const response = await fetch('/api/maps-key', {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                    },
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();
                if (!data.key) {
                    throw new Error('No API key in response');
                }
                
                setApiKey(data.key);
            } catch (error) {
                console.error('Error fetching Maps API key:', error);
                setApiError('Failed to load Google Maps');
            } finally {
                setIsLoadingKey(false);
            }
        };
        
        if (!apiKey) {
            fetchMapKey();
        }
    }, [apiKey, isLoadingKey]); // Add isLoadingKey to dependencies

    useEffect(() => {
        if (router.isReady) {
            const formatDate = (dateStr: string | string[] | undefined) => {
                if (!dateStr || Array.isArray(dateStr)) return '';
                // If date is already in DD/MM/YYYY format, return as is
                if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
                // If date is in YYYY-MM-DD format, convert to DD/MM/YYYY
                const [year, month, day] = dateStr.split('-');
                return `${day}/${month}/${year}`;
            };

            const preferencesArray = Array.isArray(preferences) 
                ? preferences as TravelPreference[]
                : [preferences] as TravelPreference[];

            const newDetails: TravelDetails = {
                ...travelDetails,
                destination: city as string || '',
                startDate: formatDate(startDate),
                endDate: formatDate(endDate),
                preferences: preferencesArray.filter(Boolean),
                budget: budget as BudgetLevel,
                language: language as SupportedLanguage
            };

            setTravelDetails(newDetails);
            
            // Set details as ready if we have the minimum required fields
            if (newDetails.destination && newDetails.startDate && newDetails.endDate) {
                setIsDetailsReady(true);
            }
        }
    }, [router.isReady, city, startDate, endDate, preferences, budget, language]);

    useEffect(() => {
        if (!city || !apiKey) return;

        const fetchCoordinates = async () => {
            try {
                const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city as string)}&key=${apiKey}`);
                if (!res.ok) {
                    throw new Error(`Failed to fetch coordinates: ${res.status}`);
                }
                const data = await res.json();
                console.log('Geocoding API Response:', data);
                
                if (data.results && data.results.length > 0) {
                    const location = data.results[0].geometry.location;
                    console.log('Parsed Location:', location);
                    
                    setTravelDetails(prevDetails => ({
                        ...prevDetails,
                        destinationLat: location.lat,
                        destinationLng: location.lng,
                    }));
                }
            } catch (error) {
                console.error('Error fetching coordinates:', error);
            }
        };

        fetchCoordinates();
    }, [city, apiKey]);

    return (
        <div className="flex flex-col h-[100%] w-full bg-white">
            <main className="flex-1 flex relative bg-white">
                {/* Chat Interface */}
                <div className={`${isMobile ? 'w-full' : 'w-[40%]'} h-[100%] border-r border-gray-200 overflow-y-auto`}>
                    {isDetailsReady ? (
                        <TravelChatComponent initialDetails={travelDetails} />
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
                    <div className={`${isMobile ? 'absolute inset-0 z-40' : 'w-[60%]'}`}>
                        {apiKey ? (
                            <MapComponent
                                city={city as string}
                                apiKey={apiKey}
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <p className="text-red-500">{apiError || 'Loading map...'}</p>
                            </div>
                        )}
                    </div>
                )}
            </main>
        </div>
    );
}