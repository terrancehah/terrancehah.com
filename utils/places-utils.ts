// Place related interfaces
export interface Place {
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
    photos?: { 
        name: string;
        widthPx?: number;
        heightPx?: number;
        authorAttributions?: Array<{
            displayName?: string;
            uri?: string;
            photoUri?: string;
        }>;
    }[];
}

import { TravelPreference } from '../managers/types';

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
export const getPlaceTypeDisplayName = (place: any): string => {
    if (place?.primaryTypeDisplayName?.text) {
        return place.primaryTypeDisplayName.text;
    }
    // Fallback to formatting the primaryType if displayName is not available
    return place.primaryType ? formatPrimaryType(place.primaryType) : 'Place';
};

// Search for a single place by text query
export const searchPlaceByText = async (
    searchText: string,
    location: { latitude: number; longitude: number }
): Promise<Place | null> => {
    try {
        if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
            console.error('Google Maps API key is missing');
            return null;
        }

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
            }
        };

        const headers = new Headers({
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.photos.name'
        });

        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Failed to search place:', {
                status: response.status,
                statusText: response.statusText,
                error: errorData
            });
            return null;
        }

        const data = await response.json();
        // console.log('Places API text search response:', data);
        
        if (!data.places || !Array.isArray(data.places) || data.places.length === 0) {
            console.error('No places found for text search:', searchText);
            return null;
        }

        // Return the first result as we only need one place
        const place = data.places[0];
        return {
            id: place.id,
            displayName: place.displayName?.text ? {
                text: place.displayName.text,
                languageCode: place.displayName.languageCode
            } : place.displayName,
            primaryType: place.primaryType || 'place',
            photos: place.photos?.map((photo: any) => ({ 
                name: photo.name,
                widthPx: photo.widthPx,
                heightPx: photo.heightPx,
                authorAttributions: photo.authorAttributions
            })) || [],
            formattedAddress: place.formattedAddress,
            location: place.location,
            primaryTypeDisplayName: place.primaryTypeDisplayName ? {
                text: place.primaryTypeDisplayName.text,
                languageCode: place.primaryTypeDisplayName.languageCode
            } : undefined
        };
    } catch (error) {
        console.error('Error searching for place:', error);
        return null;
    }
};

// Search for multiple places by text query
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

        const headers = new Headers({
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.photos.name'
        });

        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: headers,
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
                languageCode: place.displayName.languageCode
            } : place.displayName,
            primaryType: place.primaryType || 'place',
            photos: place.photos?.map((photo: any) => ({ 
                name: photo.name
            })) || [],
            formattedAddress: place.formattedAddress,
            location: place.location,
            primaryTypeDisplayName: place.primaryTypeDisplayName ? {
                text: place.primaryTypeDisplayName.text,
                languageCode: place.primaryTypeDisplayName.languageCode
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

            const headers = new Headers({
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.photos.name'
            });

            const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody)
            });

            if (response.ok) {
                const data = await response.json();
                if (data.places && Array.isArray(data.places) && data.places.length > 0) {
                    return data.places.map((place: any) => ({
                        id: place.id,
                        displayName: place.displayName?.text ? {
                            text: place.displayName.text,
                            languageCode: place.displayName.languageCode
                        } : place.displayName,
                        primaryType: place.primaryType || 'place',
                        photos: place.photos?.map((photo: any) => ({ 
                            name: photo.name
                        })) || [],
                        formattedAddress: place.formattedAddress,
                        location: place.location,
                        primaryTypeDisplayName: place.primaryTypeDisplayName ? {
                            text: place.primaryTypeDisplayName.text,
                            languageCode: place.primaryTypeDisplayName.languageCode
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