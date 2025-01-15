import React, { useState, useEffect, useMemo } from 'react';
import { Place, savedPlacesManager } from '@/utils/places-utils';

interface SavedPlacesListProps {
    onCenterMap?: (location: { latitude: number, longitude: number }) => void;
    onRemove?: (placeId: string) => void;
}

interface PhotoState {
    [key: string]: string;  // photoName -> URL mapping
}

export function SavedPlacesList({ onCenterMap, onRemove }: SavedPlacesListProps) {
    // Get places directly from savedPlacesManager
    const [places] = useState(() => savedPlacesManager.getPlaces());
    
    const [photoUrls, setPhotoUrls] = useState<PhotoState>({});

    // Memoize unique places to prevent infinite updates
    const uniquePlaces = useMemo(() => 
        Array.from(new Map(places.map(place => [place.id, place])).values()),
        [places]
    );

    useEffect(() => {
        const fetchPhotos = async () => {
            const newPhotoUrls: PhotoState = {};
            
            for (const place of uniquePlaces) {
                if (place.photos?.[0]?.name) {
                    const photoUrl = `https://places.googleapis.com/v1/${place.photos[0].name}/media?maxHeightPx=400&maxWidthPx=400&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`;
                    newPhotoUrls[place.photos[0].name] = photoUrl;
                }
            }
            
            setPhotoUrls(newPhotoUrls);
        };

        fetchPhotos();
        
        // Cleanup object URLs on unmount
        return () => {
            Object.values(photoUrls).forEach(url => {
                URL.revokeObjectURL(url);
            });
        };
    }, [uniquePlaces]);

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
        <div className="w-[70%] max-w-2xl mx-auto rounded-2xl border shadow-md border-gray-200 overflow-hidden">
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
                        className="bg-white overflow-hidden flex border-b-[1px] border-gray-200"
                    >
                        {/* Photo Section */}
                        <div className="w-1/3 min-h-32">
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
                            <p className="text-sm text-gray-600 mb-2">{place.formattedAddress}</p>
                            
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
                                {/* {onRemove && (
                                    <button
                                        onClick={() => onRemove(place.id)}
                                        className="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
                                    >
                                        Remove
                                    </button>
                                )} */}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
