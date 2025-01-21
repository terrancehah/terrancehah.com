import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Place, savedPlacesManager, searchPlaceByText } from '@/utils/places-utils';
import { SESSION_CONFIG } from '../utils/session-manager';

interface MapComponentProps {
    city: string;
    apiKey: string;
}

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
        savedPlaces: Place[];
        getSavedPlaces?: () => Place[];
    }
}

// Modify map-component.tsx to expose a proper global interface
// At the top of file
interface SavedPlacesManager {
    addPlace: (place: Place) => void;
    removePlace: (placeId: string) => void;
    getPlaces: () => Place[];
    hasPlace: (placeId: string) => boolean;
}

// Expose type-safe global methods
declare global {
    interface Window {
        savedPlacesManager: SavedPlacesManager;
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
    const scriptLoadedRef = useRef(false);
    const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
    const [savedPlaces, setSavedPlaces] = useState<Map<string, Place>>(new Map());
    const markersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
    const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
    const [markerCount, setMarkerCount] = useState(0);

    // Handle script load once
    const handleScriptLoad = useCallback(() => {
        console.log('Google Maps script loaded');
        scriptLoadedRef.current = true;
    }, []);

    useEffect(() => {
        console.log('MapComponent: Received props:', { city, apiKeyLength: apiKey?.length });
        
        if (!apiKey) {
            console.error('MapComponent: Google Maps API key is missing');
            setError('Google Maps API key is missing');
            setIsLoading(false);
            return;
        }

        if (!city) {
            // Try to get destination from session
            const sessionData = sessionStorage.getItem(SESSION_CONFIG.STORAGE_KEY);
            if (sessionData) {
                try {
                    const parsed = JSON.parse(sessionData);
                    if (!parsed.travelDetails?.destination) {
                        setError('No destination specified');
                        setIsLoading(false);
                        return;
                    }
                    city = parsed.travelDetails.destination;
                } catch (error) {
                    console.error('Error reading destination from session:', error);
                    setError('No destination specified');
                    setIsLoading(false);
                    return;
                }
            } else {
                setError('No destination specified');
                setIsLoading(false);
                return;
            }
        }

        if (!scriptLoadedRef.current && !document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')) {
            console.log('MapComponent: Loading Google Maps script...');
            // Load the script dynamically
            const script = document.createElement('script');
            script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker&v=beta&callback=Function.prototype`;
            script.async = true;
            script.onload = () => {
                console.log('Google Maps script loaded dynamically');
                scriptLoadedRef.current = true;
                // Force a re-render to initialize the map
                setIsLoading(true);
            };
            document.head.appendChild(script);
            return;
        }

        // Skip if map is already initialized
        if (map) {
            console.log('MapComponent: Map already initialized');
            return;
        }

        let isInitialized = false;

        console.log('MapComponent: Initializing map with city:', city);
        const initMap = async () => {
            if (isInitialized) return;
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
                            isInitialized = true;
                            setIsLoading(false);

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
                                    }, city);

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
    }, [city, scriptLoadedRef, apiKey]);

    useEffect(() => {
        if (!map) return;

        window.removePlaceFromMap = (placeId: string) => {
            console.log('Debug - Starting removal process for placeId:', placeId);
            
            try {
                const marker = markersRef.current.get(placeId);
                if (marker) {
                    console.log('Debug - Found marker:', marker);
                    
                    // Remove marker from map
                    marker.map = null;
                    
                    // Close info window if open
                    if (infoWindowRef.current) {
                        infoWindowRef.current.close();
                    }

                    // Remove event listeners
                    google.maps.event.clearInstanceListeners(marker);

                    // Clean up references
                    markersRef.current.delete(placeId);
                    savedPlacesManager.removePlace(placeId);

                    console.log('Debug - After removal markers:', [...markersRef.current.entries()]);
                    console.log('Debug - Successfully removed marker and place:', placeId);
                } else {
                    console.warn('Debug - Could not find marker for placeId:', placeId);
                }
            } catch (error) {
                console.error('Debug - Error during marker removal:', error);
            }
            
            // Notify components that places changed
            window.dispatchEvent(new CustomEvent('savedPlacesChanged', {
                detail: {
                    places: Array.from(savedPlacesManager.places.values()),
                    count: savedPlacesManager.places.size
                }
            }));
        };

        window.addPlaceToMap = async (data: { 
            latitude: number; 
            longitude: number; 
            title?: string;
            place?: Place;
        }) => {
            try {
                // Add this check at the start of the function
                const markerId = data.place?.id;
                if (!markerId) {
                    console.error('Debug - No place ID provided');
                    return;
                }

                // Add this check for duplicates
                if (savedPlacesManager.hasPlace(markerId)) {
                    // Check if marker exists and is on map
                    const existingMarker = markersRef.current.get(markerId);
                    if (existingMarker?.map) {
                        console.log('Debug - Place already exists and has marker:', markerId);
                        return;
                    }
                    console.log('Debug - Place exists but needs new marker:', markerId);
                }

                const [{ AdvancedMarkerElement }, { PinElement }] = await Promise.all([
                    google.maps.importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
                    google.maps.importLibrary("marker") as Promise<google.maps.MarkerLibrary>
                ]);

                const pinElement = new google.maps.marker.PinElement({
                    scale: 1
                });

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
                        lat: data.latitude,
                        lng: data.longitude
                    },
                    title: data.title,
                    content: pinElement.element,
                    gmpDraggable: false,
                });

                // Set the map property after creation
                marker.map = map;

                // Add click listener
                marker.addListener('gmp-click', () => {
                    if (data.place) {
                        window.currentInfoWindowMarker = {
                            markerId: markerId,
                            marker: marker
                        };
                        const content = createPlaceInfoWindowContent(data.place, markerId);
                        if (content && infoWindowRef.current) {
                            infoWindowRef.current.setContent(content);
                            infoWindowRef.current.open(map, marker);
                        }
                    }
                });

                // Store the marker reference
                markersRef.current.set(markerId, marker);
                
                if (data.place) {
                    // Force a re-render when adding a marker
                    setMarkerCount(prev => prev + 1);
                    setSavedPlaces(new Map(savedPlacesManager.places));
                    console.log('Debug - Added place:', savedPlacesManager.places);
                }
                console.log('Debug - Marker added successfully');

                // Notify components that places changed
                window.dispatchEvent(new CustomEvent('savedPlacesChanged', {
                    detail: {
                        places: Array.from(savedPlacesManager.places.values()),
                        count: savedPlacesManager.places.size
                    }
                }));

            } catch (err) {
                console.error('Error adding place marker:', err);
            }
        };

        window.getSavedPlaces = () => {
            return savedPlacesManager.getPlaces();
        };
        
    }, [map, infoWindow]);

    useEffect(() => {
        if (!map) return;
        
        // Re-add markers for all saved places
        const savedPlaces = savedPlacesManager.getPlaces();
        console.log('Restoring markers for saved places:', savedPlaces.length);
        
        savedPlaces.forEach(place => {
            if (place.location) {
                window.addPlaceToMap?.({
                    latitude: place.location.latitude,
                    longitude: place.location.longitude,
                    title: typeof place.displayName === 'string' ? place.displayName : place.displayName.text,
                    place: place
                });
            }
        });
    }, [map]);

    useEffect(() => {
        // Save to session storage when places change
        const sessionData = sessionStorage.getItem(SESSION_CONFIG.STORAGE_KEY);
        if (sessionData) {
            try {
                const parsed = JSON.parse(sessionData);
                const updatedPlaces = savedPlacesManager.getPlaces();
                const sessionDataWithUpdatedPlaces = {
                    ...parsed,
                    lastActive: Date.now(),
                    savedPlaces: updatedPlaces
                };
                sessionStorage.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(sessionDataWithUpdatedPlaces));
            } catch (error) {
                console.error('Error saving places to session:', error);
            }
        }
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
        const sessionData = sessionStorage.getItem(SESSION_CONFIG.STORAGE_KEY);
        if (sessionData) {
            try {
                const parsed = JSON.parse(sessionData);
                if (parsed.savedPlaces) {
                    parsed.savedPlaces.forEach((place: Place) => {
                        if (place.id) {
                            savedPlacesManager.addPlace(place);
                        }
                    });
                    // Notify components of initial load
                    window.dispatchEvent(new CustomEvent('savedPlacesChanged', {
                        detail: {
                            places: Array.from(savedPlacesManager.places.values()),
                            count: savedPlacesManager.places.size
                        }
                    }));
                }
            } catch (error) {
                console.error('Error loading saved places from session:', error);
            }
        }
    }, []);

    const getPhotoUrl = (photo: google.maps.places.Photo, index: number) => {
        return photo.getURI?.() || '';
    };

    const handleSlideChange = (_: any, index: number) => {
        if (window.currentSlide !== undefined) {
            window.currentSlide = index;
        }
    };

    //Place info window
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
        <div className="w-full h-full relative">
            <div ref={mapRef} className="w-full h-full" />
            {error && (
                <div className="absolute top-0 left-0 right-0 bg-red-500 text-white p-2 text-center">
                    {error}
                </div>
            )}
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-75">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
                </div>
            )}
        </div>
    );
};

export default MapComponent;