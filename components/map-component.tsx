import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Script from 'next/script';
import { Place, searchPlaceByText } from '@/utils/places-utils';

interface MapComponentProps {
    city: string;
    apiKey: string;
}

const globalSavedPlaces = new Map<string, Place>();

declare global {
    interface Window {
        initMap: () => void;
        currentSlide: number;
        currentInfoWindow?: google.maps.InfoWindow;
        updateCarousel: () => void;
        nextSlide: () => void;
        prevSlide: () => void;
        goToSlide: (index: number) => void;
        google: typeof google;
        removePlaceFromMap?: (title: string) => void;
        currentInfoWindowMarker?: {
            markerId: string;
            marker: google.maps.marker.AdvancedMarkerElement;
        };
        addPlaceToMap?: (place: { 
            latitude: number; 
            longitude: number; 
            title?: string;
            place?: Place;
        }) => void;
        clearPlaceMarkers?: () => void;
        savedPlaces: Map<string, Place>;
        getSavedPlaces?: () => Place[];
    }
}

declare global {
    namespace google.maps {
        interface MarkerLibrary {
            AdvancedMarkerElement: typeof google.maps.marker.AdvancedMarkerElement;
            PinElement: typeof google.maps.marker.PinElement;
        }
    }
}



const MapComponent: React.FC<MapComponentProps> = ({ city, apiKey }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const [map, setMap] = useState<google.maps.Map | null>(null);
    const [markers, setMarkers] = useState<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
    const [infoWindow, setInfoWindow] = useState<google.maps.InfoWindow | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [scriptLoaded, setScriptLoaded] = useState(false);
    const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
    const markersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
    const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
    const [savedPlaces, setSavedPlaces] = useState<Map<string, Place>>(new Map());
    const [markerCount, setMarkerCount] = useState(0);
    const savedPlacesRef = useRef<Place[]>([]);
    const lastUpdateRef = useRef<number>(0);

    // Memoize getSavedPlaces to prevent unnecessary re-renders
    const getSavedPlaces = useCallback(() => {
        const now = Date.now();
        // Only update if more than 1000ms has passed since last update
        if (now - lastUpdateRef.current < 1000) {
            return savedPlacesRef.current;
        }
        lastUpdateRef.current = now;
        return savedPlacesRef.current;
    }, []);

    // Expose getSavedPlaces to window with debouncing
    useEffect(() => {
        if (typeof window !== 'undefined') {
            window.getSavedPlaces = getSavedPlaces;
        }
        return () => {
            if (typeof window !== 'undefined') {
                delete window.getSavedPlaces;
            }
        };
    }, [getSavedPlaces]);

    // Update savedPlacesRef when places are added/removed
    const updateSavedPlaces = useCallback((places: Place[]) => {
        savedPlacesRef.current = places;
        lastUpdateRef.current = Date.now();
    }, []);

    useEffect(() => {
        console.log('MapComponent: Received props:', { city, apiKeyLength: apiKey?.length });
        
        if (!apiKey) {
            console.error('MapComponent: Google Maps API key is missing');
            setError('Google Maps API key is missing');
            setIsLoading(false);
            return;
        }

        if (!scriptLoaded || !mapRef.current) {
            console.log('MapComponent: Waiting for script to load or map ref to be ready...');
            return;
        }

        console.log('MapComponent: Initializing map with city:', city);
        const initMap = async () => {
            try {
                // Import required libraries
                const { Map } = await window.google.maps.importLibrary("maps") as google.maps.MapsLibrary;
                const { AdvancedMarkerElement } = await google.maps.importLibrary("marker") as google.maps.MarkerLibrary;
                const geocoder = new window.google.maps.Geocoder();

                geocoder.geocode(
                    { address: city },
                    async (results, status) => {
                        console.log('Geocoding response:', { status, resultsLength: results?.length });

                        if (status !== 'OK' || !results?.[0]?.geometry?.location) {
                            console.error('Geocoding failed:', status);
                            setError(`Could not find location for ${city}`);
                            setIsLoading(false);
                            return;
                        }

                        try {
                            const location = results[0].geometry.location;
                            const newMap = new Map(mapRef.current!, {
                                center: location,
                                zoom: 12,
                                mapId: '2d604af04a7c7fa8',
                            });
                            
                            setMap(newMap);

                            const newInfoWindow = new google.maps.InfoWindow({
                                maxWidth: 400
                            });
                            setInfoWindow(newInfoWindow);
                            infoWindowRef.current = newInfoWindow;

                            const createCityInfoWindowContent = async (city: string, location: google.maps.LatLng) => {
                                try {
                                    // Search for the city to get its details including photos
                                    const cityPlace = await searchPlaceByText(city, {
                                        latitude: location.lat(),
                                        longitude: location.lng()
                                    });

                                    if (!cityPlace) return null;

                                    // Create a photo carousel HTML
                                    const photoCarousel = cityPlace.photos && cityPlace.photos.length > 0
                                        ? `
                                            <div class="relative w-full" style="height: 200px;">
                                                <div class="carousel-container overflow-hidden w-full h-full">
                                                    <div class="carousel-track flex transition-transform duration-500" style="height: 100%;">
                                                        ${cityPlace.photos.slice(0, 5).map((photo, index) => `
                                                            <div class="carousel-slide w-full h-full flex-none">
                                                                <img src="https://places.googleapis.com/v1/${photo.name}/media?maxHeightPx=340&maxWidthPx=340&key=${apiKey}"
                                                                    alt="${city}"
                                                                    class="w-full h-full object-cover"
                                                                />
                                                            </div>
                                                        `).join('')}
                                                    </div>
                                                </div>
                                                <button onclick="window.prevSlide()" class="absolute left-2 top-1/2 transform -translate-y-1/2 bg-white/80 rounded-full p-1 shadow-md hover:bg-white">
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                                                        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                                                    </svg>
                                                </button>
                                                <button onclick="window.nextSlide()" class="absolute right-2 top-1/2 transform -translate-y-1/2 bg-white/80 rounded-full p-1 shadow-md hover:bg-white">
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                                                        <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                                    </svg>
                                                </button>
                                                <div class="absolute bottom-2 left-0 right-0 flex justify-center gap-1">
                                                    ${cityPlace.photos.slice(0, 5).map((_, index) => `
                                                        <button onclick="window.goToSlide(${index})" class="w-2 h-2 rounded-full bg-white/80 hover:bg-white shadow-sm carousel-dot" data-index="${index}">
                                                        </button>
                                                    `).join('')}
                                                </div>
                                            </div>
                                        `
                                        : '';

                                    // Add carousel control functions to window
                                    if (cityPlace.photos && cityPlace.photos.length > 0) {
                                        const numSlides = Math.min(cityPlace.photos.length, 5);
                                        window.currentSlide = 0;
                                        
                                        window.updateCarousel = () => {
                                            const track = document.querySelector('.carousel-track');
                                            if (track) {
                                                (track as HTMLElement).style.transform = `translateX(-${window.currentSlide * 100}%)`;
                                                // Update dots
                                                document.querySelectorAll('.carousel-dot').forEach((dot, index) => {
                                                    if (index === window.currentSlide) {
                                                        dot.classList.add('bg-white');
                                                        dot.classList.remove('bg-white/80');
                                                    } else {
                                                        dot.classList.remove('bg-white');
                                                        dot.classList.add('bg-white/80');
                                                    }
                                                });
                                            }
                                        };

                                        window.nextSlide = () => {
                                            window.currentSlide = (window.currentSlide + 1) % numSlides;
                                            window.updateCarousel();
                                        };

                                        window.prevSlide = () => {
                                            window.currentSlide = (window.currentSlide - 1 + numSlides) % numSlides;
                                            window.updateCarousel();
                                        };

                                        window.goToSlide = (index) => {
                                            window.currentSlide = index;
                                            window.updateCarousel();
                                        };
                                    }

                                    return `
                                        <div class="bg-white rounded-lg shadow-sm" style="max-width: 340px;">
                                            ${photoCarousel}
                                            <div class="p-4">
                                                <h2 class="text-xl font-semibold text-gray-900 mb-2">${city}</h2>
                                                ${cityPlace.formattedAddress 
                                                    ? `<p class="text-sm text-gray-500 mb-2">${cityPlace.formattedAddress}</p>`
                                                    : ''}
                                            </div>
                                        </div>
                                    `;
                                } catch (error) {
                                    console.error('Error creating city info window:', error);
                                    return null;
                                }
                            };

                            // Create a marker for the city
                            const cityMarker = new google.maps.marker.AdvancedMarkerElement({
                                map: newMap,
                                position: location,
                                title: city
                            });

                            // Add click listener to the marker
                            cityMarker.addListener('gmp-click', async () => {
                                if (infoWindow) {
                                    const content = createCityInfoWindowContent(city, location);
                                    if (content) {
                                        infoWindow.setContent(await content);
                                        infoWindow.open(newMap, cityMarker);
                                    }
                                }
                            });

                            markers.set(city, cityMarker);
                            
                            // Add click listener for future interaction
                            cityMarker.addListener('gmp-click', async () => {
                                const content = await createCityInfoWindowContent(city, location);
                                if (content) {
                                    newInfoWindow.setContent(content);
                                    newInfoWindow.open({
                                        anchor: cityMarker,
                                        map: newMap
                                    });
                                }
                            });

                        } catch (err) {
                            console.error('Error setting up map:', err);
                            setError('Failed to initialize map');
                        }
                    }
                );
            } catch (err) {
                console.error('Error initializing map:', err);
                setError('Failed to initialize map');
                setIsLoading(false);
            }
        };

        initMap();
    }, [city, scriptLoaded, apiKey]);

    useEffect(() => {
        if (!map) return;

        window.removePlaceFromMap = (placeId: string) => {
            console.log('Debug - Starting removal process for placeId:', placeId);

            try {
                const marker = markersRef.current.get(placeId);
                if (marker) {
                    console.log('Debug - Found marker:', marker);
                    
                    // Simply set the map to null to remove the marker
                    marker.position = null;
                    
                    // Close info window if open
                    if (infoWindowRef.current) {
                        infoWindowRef.current.close();
                    }

                    // Remove event listeners
                    google.maps.event.clearInstanceListeners(marker);

                    // Clean up references
                    markersRef.current.delete(placeId);
                    globalSavedPlaces.delete(placeId);

                    // Force update component state
                    setMarkerCount(prev => prev - 1);
                    setSavedPlaces(new Map(globalSavedPlaces));

                    console.log('Debug - After removal markers:', [...markersRef.current.entries()]);
                    console.log('Debug - Successfully removed marker and place:', placeId);
                } else {
                    console.warn('Debug - Could not find marker for placeId:', placeId);
                }
            } catch (error) {
                console.error('Debug - Error during marker removal:', error);
            }
        };

        window.addPlaceToMap = async (placeData) => {
            try {
                const [{ AdvancedMarkerElement }, { PinElement }] = await Promise.all([
                    google.maps.importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
                    google.maps.importLibrary("marker") as Promise<google.maps.MarkerLibrary>
                ]);

                const pinElement = new google.maps.marker.PinElement({
                    scale: 1
                });

                const markerId = placeData.place?.id;
                if (!markerId) {
                    console.error('Debug - No place ID provided');
                    return;
                }

                console.log('Debug - Creating marker with ID:', markerId);

                // Remove existing marker if it exists
                if (markersRef.current.has(markerId)) {
                    const existingMarker = markersRef.current.get(markerId);
                    if (existingMarker) {
                        existingMarker.map = null;
                        if (existingMarker.element) {
                            existingMarker.element.remove();
                        }
                        markersRef.current.delete(markerId);
                    }
                }

                const marker = new google.maps.marker.AdvancedMarkerElement({
                    position: {
                        lat: placeData.latitude,
                        lng: placeData.longitude
                    },
                    title: placeData.title,
                    content: pinElement.element,
                    gmpDraggable: false,
                });

                // Set the map property after creation
                marker.map = map;

                // Add click listener
                marker.addListener('gmp-click', () => {
                    if (placeData.place) {
                        window.currentInfoWindowMarker = {
                            markerId: markerId,
                            marker: marker
                        };
                        const content = createPlaceInfoWindowContent(placeData.place, markerId);
                        if (content && infoWindowRef.current) {
                            infoWindowRef.current.setContent(content);
                            infoWindowRef.current.open(map, marker);
                        }
                    }
                });

                // Store the marker reference
                markersRef.current.set(markerId, marker);
                
                if (placeData.place) {
                    globalSavedPlaces.set(markerId, placeData.place);
                    // Force a re-render when adding a marker
                    setMarkerCount(prev => prev + 1);
                    setSavedPlaces(new Map(globalSavedPlaces));
                    console.log('Debug - Added place:', globalSavedPlaces);
                }

                console.log('Debug - Marker added successfully');

            } catch (err) {
                console.error('Error adding place marker:', err);
            }
        };

        window.getSavedPlaces = () => {
            const places = Array.from(globalSavedPlaces.values());
            console.log('Getting saved places:', places);
            return places;
        };
        
    }, [map, infoWindow, markerCount]);

    // Add a useEffect to monitor savedPlaces changes
    useEffect(() => {
        console.log('Current saved places:', [...globalSavedPlaces.entries()]);
    }, [savedPlaces]);

    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && map) {
                window.google?.maps?.event?.trigger(map, 'resize');
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [map]);

    useEffect(() => {
        // Load saved places from session storage on mount
        const sessionData = sessionStorage.getItem('travelPlannerSession');
        if (sessionData) {
            try {
                const parsed = JSON.parse(sessionData);
                if (parsed.savedPlaces) {
                    const placesMap = new Map(parsed.savedPlaces.map((place: Place) => [place.id || place.name, place]));
                    setSavedPlaces(placesMap);
                    savedPlacesRef.current = Array.from(placesMap.values());
                    Object.assign(globalSavedPlaces, placesMap);
                }
            } catch (error) {
                console.error('Error loading saved places from session:', error);
            }
        }
    }, []);

    useEffect(() => {
        // Save to session storage when places change
        const sessionData = sessionStorage.getItem('travelPlannerSession');
        if (sessionData) {
            try {
                const parsed = JSON.parse(sessionData);
                sessionStorage.setItem('travelPlannerSession', JSON.stringify({
                    ...parsed,
                    savedPlaces: Array.from(savedPlaces.values())
                }));
            } catch (error) {
                console.error('Error saving places to session:', error);
            }
        }
    }, [savedPlaces]);

    const createPlaceInfoWindowContent = (place: Place, markerId: string) => {
        console.log('Debug - Creating info window content for markerId:', markerId);
        const photoUrl = place.photos && place.photos[0] 
            ? `https://places.googleapis.com/v1/${place.photos[0].name}/media?maxHeightPx=200&maxWidthPx=300&key=${apiKey}`
            : '';

        const placeTitle = typeof place.displayName === 'string' ? place.displayName : place.displayName.text;

        return `
            <div class="bg-white rounded-lg shadow-sm" style="max-width: 300px;">
                ${photoUrl ? `
                    <div style="height: 150px; width: 100%;">
                        <img src="${photoUrl}" 
                            alt="${placeTitle}"
                            style="width: 100%; height: 100%; object-fit: cover; border-top-left-radius: 0.5rem; border-top-right-radius: 0.5rem;"
                        />
                    </div>
                ` : ''}

                <div class="p-3">
                    <div class="flex justify-between items-start">
                        <h3 class="text-lg font-semibold text-gray-900 mb-1">
                            ${placeTitle}
                        </h3>
                        <button 
                            onclick="
                                (function() {
                                    console.log('Debug - Delete button clicked for markerId:', '${markerId}');
                                    if (window.removePlaceFromMap) {
                                        window.removePlaceFromMap('${markerId}');
                                        // Close the info window after deletion
                                        if (window.currentInfoWindow) {
                                            window.currentInfoWindow.close();
                                        }
                                    }
                                })();
                            "
                            class="p-1 hover:bg-red-50 rounded-full"
                            aria-label="Remove place"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                                <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                            </svg>
                        </button>
                    </div>
                    ${place.primaryTypeDisplayName 
                        ? `<div class="text-sm text-gray-600 mb-1">${place.primaryTypeDisplayName.text}</div>`
                        : ''}
                    ${place.formattedAddress 
                        ? `<p class="text-sm text-gray-500">${place.formattedAddress}</p>`
                        : ''}
                </div>
            </div>
        `;
    };

    return (
        <div className="relative w-full h-full">
            {apiKey && (
                <Script
                    src={`https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker&v=beta&callback=Function.prototype`}
                    strategy="afterInteractive"
                    onLoad={() => {
                        console.log('Google Maps script loaded');
                        setScriptLoaded(true);
                    }}
                    onError={(e) => {
                        console.error('Failed to load Google Maps script:', e);
                        setError('Failed to load Google Maps');
                        setIsLoading(false);
                    }}
                />
            )}
            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-100 text-red-500 p-4 text-center">
                    {error}
                </div>
            )}
            {isLoading && !error && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
                    <div className="text-gray-600">
                        Loading map...
                        {!apiKey && <div>Waiting for API key...</div>}
                    </div>
                </div>
            )}
            <div ref={mapRef} className="w-full h-full" />
            {/* {selectedPlace && (
                <SmallPlaceCard 
                    place={selectedPlace} 
                    onClose={() => setSelectedPlace(null)} 
                />
            )} */}
        </div>
    );
};

export default MapComponent;