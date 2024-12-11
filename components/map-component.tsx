import React, { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { Place, searchPlaceByText } from '@/utils/places-utils';

interface MapComponentProps {
    city: string;
    apiKey: string;
}

declare global {
    interface Window {
        google: {
            maps: {
                Map: typeof google.maps.Map;
                Geocoder: typeof google.maps.Geocoder;
                marker: {
                    AdvancedMarkerElement: typeof google.maps.marker.AdvancedMarkerElement;
                };
                InfoWindow: typeof google.maps.InfoWindow;
            };
        };
        initMap: () => void;
        addPlaceToMap: (place: { 
            latitude: number; 
            longitude: number; 
            title?: string;
            place?: Place;
        }) => void;
        clearPlaceMarkers: () => void;
    }
}

const MapComponent: React.FC<MapComponentProps> = ({ city, apiKey }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const [map, setMap] = useState<google.maps.Map | null>(null);
    const [markers, setMarkers] = useState<google.maps.marker.AdvancedMarkerElement[]>([]);
    const [infoWindow, setInfoWindow] = useState<google.maps.InfoWindow | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [scriptLoaded, setScriptLoaded] = useState(false);
    const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);

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
                const { AdvancedMarkerElement } = await window.google.maps.importLibrary("marker") as google.maps.MarkerLibrary;
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
                                                track.style.transform = `translateX(-${window.currentSlide * 100}%)`;
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
                            const cityMarker = new AdvancedMarkerElement({
                                map: newMap,
                                position: location,
                                title: city
                            });

                            // Add click listener to the marker
                            cityMarker.addListener('click', () => {
                                if (infoWindow) {
                                    const content = createCityInfoWindowContent(city, location);
                                    if (content) {
                                        infoWindow.setContent(content);
                                        infoWindow.open(newMap, cityMarker);
                                    }
                                }
                            });

                            setMarkers([cityMarker]);
                            
                            // Add click listener for future interaction
                            cityMarker.addListener('click', async () => {
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

        window.addPlaceToMap = async (placeData) => {
            try {
                const marker = new AdvancedMarkerElement({
                    map: map,
                    position: {
                        lat: placeData.latitude,
                        lng: placeData.longitude
                    },
                    title: placeData.title,
                });

                // Add click listener to show InfoWindow
                marker.addListener('click', () => {
                    if (infoWindow && placeData.place) {
                        const content = createInfoWindowContent(placeData.place);
                        infoWindow.setContent(content);
                        infoWindow.open({
                            anchor: marker,
                            map,
                        });
                    }
                });

                setMarkers(prev => [...prev, marker]);
            } catch (err) {
                console.error('Error adding place marker:', err);
            }
        };

        window.clearPlaceMarkers = () => {
            markers.forEach(marker => {
                marker.setMap(null);
            });
            setMarkers([]);
        };

        return () => {
            delete window.addPlaceToMap;
            delete window.clearPlaceMarkers;
        };
    }, [map, infoWindow]);

    const createInfoWindowContent = (place: Place) => {
        const photoUrl = place.photos && place.photos[0] 
            ? `https://places.googleapis.com/v1/${place.photos[0].name}/media?maxHeightPx=200&maxWidthPx=300&key=${apiKey}`
            : '';

        return `
            <div class="bg-white rounded-lg shadow-sm" style="max-width: 300px;">
                ${photoUrl ? `
                    <div style="height: 150px; width: 100%;">
                        <img src="${photoUrl}" 
                            alt="${typeof place.displayName === 'string' ? place.displayName : place.displayName.text}"
                            style="width: 100%; height: 100%; object-fit: cover; border-top-left-radius: 0.5rem; border-top-right-radius: 0.5rem;"
                        />
                    </div>
                ` : ''}
                <div class="p-3">
                    <h3 class="text-lg font-semibold text-gray-900 mb-1">
                        ${typeof place.displayName === 'string' 
                            ? place.displayName 
                            : place.displayName.text}
                    </h3>
                    ${place.primaryTypeDisplayName 
                        ? `<div class="text-sm text-gray-600 mb-1">
                            ${place.primaryTypeDisplayName.text}
                           </div>`
                        : ''}
                    ${place.formattedAddress 
                        ? `<p class="text-sm text-gray-500">
                            ${place.formattedAddress}
                           </p>`
                        : ''}
                </div>
            </div>
        `;
    };

    return (
        <div className="relative w-full h-full min-h-[340px]">
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
            {selectedPlace && (
                <SmallPlaceCard 
                    place={selectedPlace} 
                    onClose={() => setSelectedPlace(null)} 
                />
            )}
        </div>
    );
};

export default MapComponent;