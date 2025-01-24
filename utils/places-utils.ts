// Place related interfaces
export interface Place {
    name: string | undefined;
    id: string;
    displayName: {
        text: string;
        languageCode: string;
    } | string;
    formattedAddress?: string;
    location?: {
        latitude: number;
        longitude: number;
    };
    primaryType: string;
    primaryTypeDisplayName?: {
        text: string;
        languageCode: string;
    };
    photos: { 
        name: string;
        widthPx?: number;
        heightPx?: number;
        authorAttributions?: Array<{
            displayName?: string;
            uri?: string;
            photoUri?: string;
        }>;
    }[];
    // Optional indices for itinerary planning
    dayIndex?: number;
    orderIndex?: number;
}

interface GooglePlaceResponse {
    id: string;
    name?: string;
    displayName?: {
        text: string;
        languageCode: string;
    };
    formattedAddress?: string;
    location?: {
        latitude: number;
        longitude: number;
    };
    primaryType?: string;
    primaryTypeDisplayName?: {
        text: string;
        languageCode: string;
    };
    photos?: Array<{
        name: string;
        widthPx?: number;
        heightPx?: number;
        authorAttributions?: Array<{
            displayName?: string;
            uri?: string;
            photoUri?: string;
        }>;
    }>;
}

import { TravelPreference, TravelSession } from '../managers/types';
import { getStoredSession, getStoredMetrics, SESSION_CONFIG, safeStorageOp, storage } from './session-manager';

// Updated preference to place types mapping based on travel-rizz.html
export const preferenceToPlaceTypes: Record<TravelPreference, string[]> = {
    [TravelPreference.Culture]: [
        'museum',
        'cultural_center',
        'cultural_landmark',
        'historical_landmark',
        'monument',
        'art_gallery',
        'historical_place'
    ],
    [TravelPreference.Nature]: [
        'national_park',
        'state_park',
        'botanical_garden',
        'wildlife_park',
        'garden',
        'hiking_area',
        'wildlife_refuge'
    ],
    [TravelPreference.Food]: [
        'restaurant',
        'fine_dining_restaurant',
        'cafe',
        'food_court',
        'bakery',
        'dessert_shop',
        'bar_and_grill'
    ],
    [TravelPreference.Relaxation]: [
        'spa',
        'wellness_center',
        'shopping_mall',
        'beach',
        'garden',
        'plaza',
        'yoga_studio'
    ],
    [TravelPreference.Adventure]: [
        'adventure_sports_center',
        'amusement_park',
        'hiking_area',
        'sports_complex',
        'water_park',
        'off_roading_area',
        'sports_activity_location'
    ],
    [TravelPreference.Shopping]: [ // Arts & Museum
        'art_gallery',
        'art_studio',
        'performing_arts_theater',
        'auditorium',
        'concert_hall',
        'museum',
        'opera_house'
    ]
};

// Helper function to get place types based on preferences
export function getPlaceTypesFromPreferences(preferences: TravelPreference[]): string[] {
    try {
        // Track used types to avoid repeats
        const usedTypes = new Set<string>();
        const resultTypes: string[] = [];
        
        // Process each preference
        preferences.forEach(pref => {
            const availableTypes = preferenceToPlaceTypes[pref]?.filter(
                type => !usedTypes.has(type)
            ) || [];
            
            // Take 2-3 random types from each preference
            const numTypes = Math.min(Math.floor(Math.random() * 2) + 2, availableTypes.length);
            const selectedTypes = availableTypes
                .sort(() => Math.random() - 0.5)
                .slice(0, numTypes);
                
            // Add to results and mark as used
            selectedTypes.forEach(type => {
                resultTypes.push(type);
                usedTypes.add(type);
            });
        });

        return resultTypes;
    } catch (error) {
        console.error('Error getting place types from preferences:', error);
        return ['tourist_attraction']; // Default fallback
    }
}

// Helper function to format primary type
export const formatPrimaryType = (type: string): string => {
    return type.split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
};

// Helper function to get display name for place type
export const getDisplayName = (place: Place): string => {
    if (typeof place.displayName === 'string') {
        return place.displayName;
    }
    return place.displayName?.text || place.name || '';
};

// Function to filter out duplicate places
export function filterUniquePlaces(places: Place[]): Place[] {
    if (!places || !Array.isArray(places)) return [];

    // Get saved places from global state if available
    const savedPlaces = savedPlacesManager.getPlaces();

    const savedPlaceIds = new Set(savedPlaces.map(place => place.id));
    const savedPlaceNames = new Set(savedPlaces.map(place => 
        typeof place.displayName === 'string' 
            ? place.displayName.toLowerCase() 
            : place.displayName.text.toLowerCase()
    ));

     // Filter out places that:
    // 1. Have same ID as saved place
    // 2. Have same name as saved place
    return places.filter(place => {
        if (!place.id) return false;
        if (savedPlaceIds.has(place.id)) return false;
        
        const placeName = typeof place.displayName === 'string' 
            ? place.displayName.toLowerCase()
            : place.displayName.text.toLowerCase();
            
        if (savedPlaceNames.has(placeName)) return false;
        
        return true;
    });
}

// Add SavedPlacesManager interface
export interface SavedPlacesManager {
    places: Map<string, Place>;
    addPlace: (place: Place) => void;
    removePlace: (id: string) => void;
    getPlaces: () => Place[];
    getPlaceById: (id: string) => Place | undefined;
    hasPlace: (id: string) => boolean;
    updatePlace: (place: Place) => void;
    updatePlaces: (updatedPlaces: Place[]) => void;
    _persist: () => void;
    _notifyChange: () => void;
    serialize: () => string;
}

const STORAGE_KEY = 'saved_places';

// SavedPlacesManager singleton
const createSavedPlacesManager = (): SavedPlacesManager => {
    const places = new Map<string, Place>();
    let initialized = false;

    // Load places from sessionStorage
    const loadFromStorage = () => {
        if (!initialized && typeof window !== 'undefined') {
            const session = getStoredSession();
            if (session?.savedPlaces) {
                try {
                    // Clear existing places before loading
                    places.clear();
                    
                    session.savedPlaces.forEach(place => {
                        if (place?.id) {
                            places.set(place.id, place);
                        }
                    });
                } catch (error) {
                    console.error('[savedPlacesManager] Error loading places:', error);
                }
            }
            initialized = true;
        }
    };

    return {
        places,
        addPlace(place: Place) {
            loadFromStorage(); // Ensure places are loaded
            if (place?.id) {
                places.set(place.id, place);
                this._persist();
                this._notifyChange();
            }
        },
        removePlace(id: string) {
            loadFromStorage(); // Ensure places are loaded
            places.delete(id);
            this._persist();
            this._notifyChange();
        },
        getPlaces(): Place[] {
            loadFromStorage(); // Ensure places are loaded
            return Array.from(places.values());
        },
        getPlaceById(id: string): Place | undefined {
            loadFromStorage(); // Ensure places are loaded
            return places.get(id);
        },
        hasPlace(id: string): boolean {
            loadFromStorage(); // Ensure places are loaded
            return places.has(id);
        },
        updatePlace(place: Place) {
            if (place?.id && places.has(place.id)) {
                places.set(place.id, place);
                this._persist();
                this._notifyChange();
            }
        },
        updatePlaces(updatedPlaces: Place[]) {
            loadFromStorage(); // Ensure places are loaded
            updatedPlaces.forEach(place => {
                if (place?.id) {
                    places.set(place.id, place);
                }
            });
            this._persist();
            this._notifyChange();
        },
        _persist() {
            if (typeof window !== 'undefined') {
                const placesArray = Array.from(places.values());
                
                // Update travel_rizz_session
                const session = getStoredSession();
                if (session) {
                    session.savedPlaces = placesArray;
                    session.savedPlacesCount = places.size;
                    safeStorageOp(() => {
                        storage?.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
                    }, undefined);
                }
            }
        },
        _notifyChange() {
            if (typeof window !== 'undefined') {
                window.savedPlaces = Array.from(this.places.values());
                // Dispatch event with type to handle different update scenarios
                window.dispatchEvent(new CustomEvent('savedPlacesChanged', {
                    detail: {
                        places: Array.from(this.places.values()),
                        count: this.places.size,
                        type: 'update'
                    }
                }));
            }
        },
        serialize() {
            return JSON.stringify(Array.from(places.values()));
        }
    };
};

export const savedPlacesManager = createSavedPlacesManager();

// Initialize on client side
if (typeof window !== 'undefined') {
    savedPlacesManager.places = new Map<string, Place>();
}

// Declare window interface for saved places
declare global {
    interface Window {
        savedPlaces: Place[];
        addPlaceToMap?: (place: {
            latitude: number;
            longitude: number;
            title?: string;
            place?: Place;
        }) => void;
        getSavedPlaces?: () => Place[];
    }
}

// Helper function to handle different search strategies
async function searchWithStrategy(
    searchText: string,
    location: { latitude: number; longitude: number },
    cityName: string,
    useAlternateSearch: boolean
): Promise<any> {
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
        throw new Error('Google Maps API key is missing');
    }

    const headers = {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.photos.name,places.photos.widthPx,places.photos.heightPx'
    } as const;

    // Choose query based on whether we're doing alternate search
    const query = useAlternateSearch 
        ? `different ${searchText} in ${cityName}`
        : `${searchText} ${cityName}`;

    console.log(`[searchWithStrategy] Using ${useAlternateSearch ? 'alternate' : 'original'} search:`, query);
    
    const result = await trySearch(query, headers, location);
    return result;
}

async function trySearch(
    query: string,
    headers: any,
    location: { latitude: number; longitude: number }
): Promise<any> {
    try {
        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                textQuery: query,
                locationBias: {
                    circle: {
                        center: {
                            latitude: location.latitude,
                            longitude: location.longitude
                        },
                        radius: 20000.0
                    }
                },
                maxResultCount: 1
            })
        });

        if (!response.ok) {
            console.error('[trySearch] Search failed:', {
                status: response.status,
                statusText: response.statusText,
                query
            });
            return null;
        }

        const data = await response.json();
        if (!data.places?.[0]) {
            console.log('[trySearch] No places found for query:', query);
            return null;
        }

        console.log('[trySearch] Found new place:', {
            id: data.places[0].id,
            name: data.places[0].displayName?.text || data.places[0].name
        });

        return { places: [data.places[0]] };
    } catch (error) {
        console.error('[trySearch] Error:', error);
        return null;
    }
}

export async function searchPlaceByText(
    searchText: string,
    location: { latitude: number; longitude: number },
    destination: string
): Promise<Place | null> {
    console.log('[searchPlaceByText] Starting search with:', {
        searchText,
        location,
        destination
    });

    try {
        const cityName = destination;
        const result = await searchWithStrategy(searchText, location, cityName, false);
        
        if (!result?.places?.[0]) {
            return null;
        }

        const place = transformPlaceResponse(result.places[0]);
        if (!place) {
            return null;
        }

        // Check if place is already saved using savedPlacesManager
        const isAlreadySaved = savedPlacesManager.hasPlace(place.id);
        
        if (!isAlreadySaved) {
            console.log('[searchPlaceByText] Adding new place:', {
                id: place.id,
                name: getDisplayName(place)
            });
            savedPlacesManager.addPlace(place);
            
            // Update metrics
            const metrics: TravelSession = metricsManager.get();
            metrics.savedPlacesCount = savedPlacesManager.places.size;
            metricsManager.update(metrics);
        }

        console.log('[searchPlaceByText] Found place:', {
            id: place.id,
            name: getDisplayName(place),
            isAlreadySaved
        });

        return place;
    } catch (error) {
        console.error('[searchPlaceByText] Error searching for place:', error);
        return null;
    }
}

// Initialize metrics in storage
function initializeMetrics(): TravelSession {
    if (typeof window === 'undefined') {
        return {
            sessionId: '',
            startTime: Date.now(),
            lastActive: Date.now(),
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            destination: '',
            startDate: '',
            endDate: '',
            preferences: [],
            budget: '',
            language: '',
            transport: [],
            savedPlaces: [],
            currentStage: 1,
            totalPrompts: 0,
            stagePrompts: { 1: 0, 2: 0, 3: 0 },
            savedPlacesCount: 0,
            isPaid: false,
            paymentReference: ''
        };
    }

    const session = getStoredSession();
    if (!session) {
        return initializeMetrics();
    }
    // Always ensure savedPlacesCount matches actual saved places
    session.savedPlacesCount = savedPlacesManager.places.size;
    return session;
}

// Update metrics in storage
function updateMetrics(session: TravelSession) {
    if (typeof window === 'undefined') return;
    try {
        const storedSession = getStoredSession();
        if (!storedSession) return;
        
        // Update only metrics-related fields
        storedSession.totalPrompts = session.totalPrompts;
        storedSession.stagePrompts = session.stagePrompts;
        storedSession.savedPlacesCount = session.savedPlacesCount;
        
        sessionStorage.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(storedSession));
    } catch (error) {
        console.error('[Places] Error updating metrics:', error);
    }
}

// Export the metrics functions
export const metricsManager = {
    get: initializeMetrics,
    update: updateMetrics
};

// Helper function to transform Google Places API response to our Place type
function transformPlaceResponse(place: GooglePlaceResponse): Place | null {
    if (!place) return null;

    console.log('[transformPlaceResponse] Input place:', {
        id: place.id,
        photos: place.photos?.map(p => ({ name: p.name })),
        primaryTypeDisplayName: place.primaryTypeDisplayName
    });

    const displayName = place.displayName?.text 
        ? { text: place.displayName.text, languageCode: place.displayName.languageCode || 'en' }
        : place.name || '';

    // Ensure photos array is properly formatted
    const photos = (place.photos || [])
        .filter((photo): photo is NonNullable<typeof photo> => 
            Boolean(photo && photo.name)
        )
        .map(photo => ({
            name: photo.name,
            widthPx: photo.widthPx,
            heightPx: photo.heightPx,
            authorAttributions: photo.authorAttributions
        }));

    const transformed = {
        id: place.id,
        name: place.name,
        displayName,
        primaryType: place.primaryType || 'place',
        photos,
        formattedAddress: place.formattedAddress,
        location: place.location,
        primaryTypeDisplayName: place.primaryTypeDisplayName 
            ? { text: place.primaryTypeDisplayName.text, languageCode: place.primaryTypeDisplayName.languageCode || 'en' }
            : undefined
    };

    console.log('[transformPlaceResponse] Transformed place:', {
        id: transformed.id,
        photos: transformed.photos.map(p => ({ name: p.name })),
        primaryTypeDisplayName: transformed.primaryTypeDisplayName
    });

    return transformed;
}

export const searchMultiplePlacesByText = async (
    searchText: string,
    location: { latitude: number; longitude: number },
    maxResults: number = 5
): Promise<Place[]> => {
    try {
        if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
            console.error('Google Maps API key is missing');
            return [];
        }

        console.log('Executing searchMultiplePlacesByText with params:', {
            searchText,
            location,
            maxResults
        });

        const requestBody = {
            textQuery: searchText,
            locationBias: {
                circle: {
                    center: {
                        latitude: location.latitude,
                        longitude: location.longitude
                    },
                    radius: 20000.0 // 20km radius
                }
            },
            maxResultCount: maxResults
        };

        const headers = {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.photos.name,places.photos.widthPx,places.photos.heightPx'
        } as const;

        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Failed to search places:', {
                status: response.status,
                statusText: response.statusText,
                error: errorData
            });
            return [];
        }

        const data = await response.json();
        
        if (!data.places || !Array.isArray(data.places) || data.places.length === 0) {
            console.log('No places found for text search:', searchText);
            return [];
        }

        return data.places.map((place: any) => ({
            id: place.id,
            displayName: place.displayName?.text ? {
                text: place.displayName.text,
                languageCode: place.displayName.languageCode || 'en'
            } : place.displayName,
            primaryType: place.primaryType || 'place',
            photos: place.photos?.map((photo: any) => ({ 
                name: photo.name,
                widthPx: photo.widthPx,
                heightPx: photo.heightPx
            })) || [],
            formattedAddress: place.formattedAddress,
            location: place.location,
            primaryTypeDisplayName: place.primaryTypeDisplayName ? {
                text: place.primaryTypeDisplayName.text,
                languageCode: place.primaryTypeDisplayName.languageCode || 'en'
            } : undefined
        }));
    } catch (error) {
        console.error('Error searching for places:', error);
        return [];
    }
};

// Fetch places from Google Places API
export const fetchPlaces = async (
    latitude: number,
    longitude: number,
    preferences?: TravelPreference[],
    maxResults: number = 5,
    placeTypes?: string[]
): Promise<Place[]> => {
    try {
        if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
            console.error('Google Maps API key is missing');
            return [];
        }

        const fromPreferences = !!preferences && preferences.length > 0;
        const fromPlaceTypes = !!placeTypes && placeTypes.length > 0;
        
        if (!fromPreferences && !fromPlaceTypes) {
            console.error('No preferences or place types provided');
            return [];
        }

        // Use preferences if provided, otherwise use placeTypes, otherwise use defaults
        let includedTypes: string[] = [];
        if (fromPreferences) {
            includedTypes = getPlaceTypesFromPreferences(preferences!);
        } else if (fromPlaceTypes) {
            includedTypes = placeTypes!;
        }

        console.log('Executing fetchplaces with params:', {
            latitude,
            longitude,
            includedTypes,
            maxResults,
            fromPreferences: !!preferences?.length,
            fromPlaceTypes: !!placeTypes?.length
        });

        // First try nearby search
        try {
            const requestBody = {
                includedTypes,
                maxResultCount: maxResults,
                locationRestriction: {
                    circle: {
                        center: {
                            latitude: latitude,
                            longitude: longitude
                        },
                        radius: 20000.0 // 20km radius
                    }
                }
            };

            const headers = {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.photos.name,places.photos.widthPx,places.photos.heightPx'
            } as const;

            const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody)
            });

            if (response.ok) {
                const data = await response.json();
                if (data.places && Array.isArray(data.places) && data.places.length > 0) {
                    return data.places.map((place: any) => ({
                        id: place.id,
                        displayName: place.displayName?.text ? {
                            text: place.displayName.text,
                            languageCode: place.displayName.languageCode || 'en'
                        } : place.displayName,
                        primaryType: place.primaryType || 'place',
                        photos: place.photos?.map((photo: any) => ({ 
                            name: photo.name,
                            widthPx: photo.widthPx,
                            heightPx: photo.heightPx
                        })) || [],
                        formattedAddress: place.formattedAddress,
                        location: place.location,
                        primaryTypeDisplayName: place.primaryTypeDisplayName ? {
                            text: place.primaryTypeDisplayName.text,
                            languageCode: place.primaryTypeDisplayName.languageCode || 'en'
                        } : undefined
                    }));
                }
            }

            const errorData = await response.text();
            console.error('Failed to fetch places:', {
                status: response.status,
                statusText: response.statusText,
                error: errorData
            });
        } catch (error) {
            console.error('Error in nearby search:', error);
        }

        // If nearby search fails, try text search as fallback
        console.log('Falling back to text search...');
        const searchQuery = fromPlaceTypes ? placeTypes![0] : preferences![0];
        return await searchMultiplePlacesByText(searchQuery, { latitude, longitude }, maxResults);

    } catch (error) {
        console.error('Error fetching places:', error);
        return [];
    }
};