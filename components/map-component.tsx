import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Place, savedPlacesManager, searchPlaceByText } from '@/utils/places-utils';
import { SESSION_CONFIG } from '../utils/session-manager';
import { travelInfoManager } from '../utils/travel-info-utils';

interface MapComponentProps {
    city: string;
    apiKey: string;
}

declare global {
    interface Window {
        setupMapInstance: () => void;
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
        namespace geometry {
            namespace encoding {
                function decodePath(encodedPath: string): google.maps.LatLng[];
            }
        }
    }
}


const MapComponent: React.FC<MapComponentProps> = ({ city, apiKey }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<google.maps.Map | null>(null);
    const [map, setMap] = useState<google.maps.Map | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const scriptLoadedRef = useRef(false);
    const geometryLoadedRef = useRef(false);
    const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
    const [savedPlaces, setSavedPlaces] = useState<Map<string, Place>>(new Map());
    const markersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
    const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
    const [markerCount, setMarkerCount] = useState(0);
    const routesRef = useRef<Map<string, google.maps.Polyline>>(new Map());

    useEffect(() => {
        if (!apiKey) return;

        const loadGoogleMapsScript = () => {
            if (window.google?.maps) {
                setupMapInstance();
            } else if (!scriptLoadedRef.current && !document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')) {
                const script = document.createElement('script');
                script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker,geometry&v=beta&callback=setupMapInstance`;
                script.async = true;
                script.defer = true;
                document.head.appendChild(script);
                scriptLoadedRef.current = true;
            }
        };

        // Initial map setup and geometry library check
        async function setupMapInstance() {
            if (!mapRef.current || mapInstanceRef.current) return;

            try {
                // Use the city prop directly, fallback to session storage if needed
                let targetCity = city;
                if (!targetCity) {
                    const sessionData = sessionStorage.getItem(SESSION_CONFIG.STORAGE_KEY);
                    if (sessionData) {
                        const parsed = JSON.parse(sessionData);
                        targetCity = parsed.city;
                    }
                }

                if (!targetCity) {
                    console.error('No city specified');
                    setIsLoading(false);
                    return;
                }

                const location = await getLocation(targetCity);
                const map = new window.google.maps.Map(mapRef.current, {
                    zoom: 12,
                    center: location,
                    mapId: '2d604af04a7c7fa8'
                });

                mapInstanceRef.current = map;
                setMap(map);
                markersRef.current = new Map();
                routesRef.current = new Map();

                // Initialize the InfoWindow
                infoWindowRef.current = new window.google.maps.InfoWindow({
                    maxWidth: 300,
                    pixelOffset: new window.google.maps.Size(0, -30)
                });

                setIsLoading(false);

                // Check if geometry library is loaded
                if (isGeometryReady()) {
                    geometryLoadedRef.current = true;
                } else {
                    // Poll for geometry library
                    const checkGeometry = setInterval(() => {
                        if (isGeometryReady()) {
                            geometryLoadedRef.current = true;
                            clearInterval(checkGeometry);
                        }
                    }, 100);
                    // Clear interval after 10 seconds to prevent infinite polling
                    setTimeout(() => clearInterval(checkGeometry), 10000);
                }
            } catch (error) {
                console.error('Error setting up map:', error);
                setIsLoading(false);
            }
        }

        window.setupMapInstance = setupMapInstance;
        loadGoogleMapsScript();

        return () => {
            delete window.setupMapInstance;
        };
    }, [apiKey]);

    useEffect(() => {
        if (!mapInstanceRef.current) return;

        const setupMapFeatures = async () => {
            if (!mapInstanceRef.current) return;

            try {
                const location = await getLocation(city);
                
                // Update existing map instead of creating new one
                mapInstanceRef.current.setCenter(location);
                mapInstanceRef.current.setZoom(12);
                
                setIsLoading(false);
            } catch (error) {
                console.error('Error updating map features:', error);
                setIsLoading(false);
            }
        };

        setupMapFeatures();
    }, [city]);

    useEffect(() => {
        if (!map) return;

        const initializeMap = async () => {
            // Wait for map to be idle before restoring markers
            await new Promise<void>((resolve) => {
                google.maps.event.addListenerOnce(map, 'idle', () => {
                    resolve();
                });
            });
            
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
        };

        initializeMap();
    }, [map]);

    useEffect(() => {
        if (!mapInstanceRef.current) return;

        window.removePlaceFromMap = (placeId: string) => {
            console.log('Debug - Starting removal process for placeId:', placeId);
            
            try {
                const marker = markersRef.current.get(placeId);
                if (marker) {
                    console.log('Debug - Found marker:', marker);
                    
                    marker.map = null;
                    
                    if (infoWindowRef.current) {
                        infoWindowRef.current.close();
                    }

                    google.maps.event.clearInstanceListeners(marker);

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
                const markerId = data.place?.id || data.title || String(Date.now());
                const pinElement = new window.google.maps.marker.PinElement({
                    background: "#FF4444",  // Bright red
                    borderColor: "#CC0000", // Darker red border
                    glyphColor: "#FFFFFF",  // White glyph for better contrast
                });

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

                if (data.place) {
                    savedPlacesManager.addPlace(data.place);
                    setMarkerCount(prev => prev + 1);
                    setSavedPlaces(new Map(savedPlacesManager.places));
                }

                // Ensure the marker is properly added to the map
                marker.map = mapInstanceRef.current;

                marker.addListener('gmp-click', () => {
                    if (data.place) {
                        // Close any existing InfoWindow
                        infoWindowRef.current?.close();
                        
                        window.currentInfoWindowMarker = {
                            markerId: markerId,
                            marker: marker
                        };
                        
                        const content = createPlaceInfoWindowContent(data.place, markerId);
                        if (content && infoWindowRef.current && mapInstanceRef.current) {
                            const position = marker.position as google.maps.LatLng;
                            infoWindowRef.current.setContent(content);
                            infoWindowRef.current.setPosition(position);
                            infoWindowRef.current.open(mapInstanceRef.current);
                        }
                    }
                });

                markersRef.current.set(markerId, marker);
                
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
        
    }, [mapInstanceRef.current]); // Only depend on the map instance

    useEffect(() => {
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

    useEffect(() => {
        const handlePlacesChanged = (event: CustomEvent) => {
            if (!mapInstanceRef.current) return;
            
            // Clear ALL existing routes
            routesRef.current.forEach(route => {
                route.setMap(null);
            });
            routesRef.current.clear();
            
            // Group and draw routes
            const places = savedPlacesManager.getPlaces();
            const days = places.reduce((acc, place) => {
                if (place.dayIndex === undefined) return acc;
                const dayId = `day-${place.dayIndex}`;
                if (!acc[dayId]) acc[dayId] = [];
                acc[dayId].push(place);
                return acc;
            }, {} as Record<string, Place[]>);

            Object.entries(days).forEach(([dayId, places]) => {
                const sortedPlaces = [...places].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
                const dayIndex = parseInt(dayId.replace('day-', ''));
                // Array of distinct colors for routes
                const colors = [
                    '#2196F3', // Blue
                    '#9C27B0', // Purple
                    '#795548', // Brown
                    '#FF9800', // Orange
                    '#009688', // Teal
                    '#E91E63', // Pink
                    '#673AB7', // Deep Purple
                    '#3F51B5', // Indigo
                    '#00BCD4', // Cyan
                    '#4CAF50'  // Green
                ];
                const color = colors[dayIndex % colors.length];
                drawDayRoute(dayId, sortedPlaces, color);
            });
        };

        window.addEventListener('savedPlacesChanged', handlePlacesChanged as EventListener);
        return () => {
            window.removeEventListener('savedPlacesChanged', handlePlacesChanged as EventListener);
        };
    }, []);

    const drawDayRoute = async (dayId: string, places: Place[], color: string) => {
        console.log(`drawDayRoute called for day ${dayId} with ${places.length} places`);
        
        const existingRoute = routesRef.current.get(dayId);
        if (existingRoute) {
            existingRoute.setMap(null);
            routesRef.current.delete(dayId);
        }

        if (!places || places.length < 2 || !mapInstanceRef.current || !isGeometryReady()) {
            console.log('Not ready:', {
                places: places?.length,
                mapReady: !!mapInstanceRef.current,
                geometryReady: isGeometryReady()
            });
            return;
        }

        const coordinates: google.maps.LatLng[] = [];
        
        for (let i = 0; i < places.length - 1; i++) {
            const place1 = places[i];
            const place2 = places[i + 1];
            
            if (!place1.location || !place2.location) {
                console.log('Missing location for place:', { 
                    place1Name: place1.name,
                    place2Name: place2.name,
                    place1Location: place1.location,
                    place2Location: place2.location
                });
                continue;
            }

            console.log(`Getting travel info between ${place1.name} and ${place2.name}`);
            const info = await travelInfoManager.getTravelInfo(place1, place2);
            
            console.log('Received travel info:', info);
            
            if (info.legPolyline) {
                console.log('Decoding polyline:', info.legPolyline);
                try {
                    const path = google.maps.geometry.encoding.decodePath(info.legPolyline);
                    console.log('Decoded path:', path);
                    if (path) {
                        coordinates.push(...path);
                    }
                } catch (error) {
                    console.error('Error decoding polyline:', error);
                }
            } else {
                console.log('No polyline in travel info');
            }
        }

        console.log(`Found ${coordinates.length} coordinates for route`);
        if (coordinates.length > 0) {
            const route = new google.maps.Polyline({
                path: coordinates,
                geodesic: true,
                strokeColor: color,
                strokeOpacity: 0.8,
                strokeWeight: 3,
                map: mapInstanceRef.current
            });

            console.log('Created new polyline:', route);
            routesRef.current.set(dayId, route);
        }
    };

    const isGeometryReady = () => {
        return !!(
            window.google?.maps?.geometry?.encoding?.decodePath &&
            typeof window.google.maps.geometry.encoding.decodePath === 'function'
        );
    };

    const getLocation = async (city: string) => {
        const geocoder = new window.google.maps.Geocoder();

        return new Promise<google.maps.LatLng>((resolve, reject) => {
            geocoder.geocode(
                { address: city },
                (results, status) => {
                    if (status !== 'OK' || !results?.[0]?.geometry?.location) {
                        console.error('Geocoding failed:', status);
                        reject('Could not find location for ' + city);
                    } else {
                        resolve(results[0].geometry.location);
                    }
                }
            );
        });
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