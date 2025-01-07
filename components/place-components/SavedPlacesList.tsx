import React, { useState, useEffect, useMemo } from 'react';
import { Place } from '@/utils/places-utils';

interface SavedPlacesListProps {
    places: Place[];
    onCenterMap?: (location: { latitude: number, longitude: number }) => void;
    onRemove?: (placeId: string) => void;
}

interface PhotoState {
    [key: string]: string;  // photoName -> URL mapping
}

export const SavedPlacesList: React.FC<SavedPlacesListProps> = ({ places, onCenterMap, onRemove }) => {
    // Memoize unique places to prevent infinite updates
    const uniquePlaces = useMemo(() => 
        Array.from(new Map(places.map(place => [place.id, place])).values()),
        [places] // Only recompute when places array changes
    );
    
    console.log('[SavedPlacesList] Unique places:', uniquePlaces.length);

    useEffect(() => {
        uniquePlaces.forEach(place => {
            console.log('[SavedPlacesList] Place details:', {
                id: place.id,
                hasPhotos: Boolean(place.photos),
                photoCount: place.photos?.length,
                firstPhoto: place.photos?.[0],
                rawPhotos: place.photos
            });
        });
    }, [uniquePlaces]);

    const [photoUrls, setPhotoUrls] = useState<PhotoState>({});

    useEffect(() => {
        const fetchPhotos = async () => {
            const newPhotoUrls: PhotoState = {};
            
            for (const place of uniquePlaces) {
                if (place.photos?.[0]?.name) {
                    try {
                        const response = await fetch(
                            `https://places.googleapis.com/v1/${place.photos[0].name}/media`, {
                            headers: {
                                'X-Goog-Api-Key': process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
                                'X-Goog-FieldMask': 'photoUri'
                            }
                        });
                        
                        if (response.ok) {
                            const photoData = await response.json();
                            if (photoData.photoUri) {
                                newPhotoUrls[place.photos[0].name] = photoData.photoUri;
                            }
                        } else {
                            console.error(`Failed to fetch photo for place ${place.id}:`, await response.text());
                        }
                    } catch (error) {
                        console.error(`Error fetching photo for place ${place.id}:`, error);
                    }
                }
            }
            
            setPhotoUrls(prev => ({...prev, ...newPhotoUrls}));
        };

        fetchPhotos();
    }, [uniquePlaces]); // Now safe to use uniquePlaces as dependency

    console.log('[SavedPlacesList] Rendering with places:', uniquePlaces.map(p => ({
        id: p.id,
        displayName: p.displayName,
        photos: p.photos,
        primaryType: p.primaryType,
        primaryTypeDisplayName: p.primaryTypeDisplayName
    })));

    if (!uniquePlaces || uniquePlaces.length === 0) {
        return (
            <div className="text-center p-4">
                <p>No saved places yet.</p>
            </div>
        );
    }

    return (
        <div className="w-full max-w-2xl mx-auto rounded-2xl border border-gray-200 overflow-hidden">
            {uniquePlaces.map((place: Place) => {
                const photoName = place.photos?.[0]?.name;
                const photoUrl = photoName && photoUrls[photoName]
                    ? photoUrls[photoName]
                    : '/images/placeholder-image.jpg';
                
                console.log('[SavedPlacesList] Rendering place:', {
                    id: place.id,
                    photoName,
                    hasPhotoUrl: Boolean(photoUrls[photoName || ''])
                });
                
                // Ensure photos array exists and has valid entries
                const hasValidPhoto = Array.isArray(place.photos) && 
                    place.photos.length > 0 && 
                    place.photos[0]?.name;
                
                return (
                    <div 
                        key={place.id} 
                        className="bg-white shadow-sm overflow-hidden flex border border-gray-100"
                    >
                        {/* Photo Section */}
                        <div className="w-1/3 h-40">
                            <img
                                src={photoUrl}
                                alt={typeof place.displayName === 'string' ? place.displayName : place.displayName.text}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                    console.error('[SavedPlacesList] Image load error for place:', place.id);
                                    e.currentTarget.src = '/images/placeholder-image.jpg';
                                }}
                            />
                        </div>

                        {/* Content Section */}
                        <div className="w-2/3 p-4">
                            <h3 className="text-lg font-bold text-gray-900 mb-1">
                                {typeof place.displayName === 'string' 
                                    ? place.displayName 
                                    : place.displayName.text}
                            </h3>
                            <p className="text-sm text-gray-500 mb-2">
                                {place.primaryTypeDisplayName?.text || place.primaryType}
                            </p>
                            <p className="text-sm text-gray-600 mb-3">{place.formattedAddress}</p>
                            
                            {/* Actions */}
                            <div className="flex justify-end space-x-2">
                                {onCenterMap && place.location && (
                                    <button
                                        onClick={() => onCenterMap(place.location!)}
                                        className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                                    >
                                        Center on Map
                                    </button>
                                )}
                                {/* Remove button commented out
                                {onRemove && (
                                    <button
                                        onClick={() => onRemove(place.id)}
                                        className="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
                                    >
                                        Remove
                                    </button>
                                )}
                                */}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
