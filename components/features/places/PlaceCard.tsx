import React, { useEffect, useCallback } from 'react';
import { Place, formatPrimaryType, savedPlacesManager, searchPlaceByText } from '@/utils/places-utils';

interface PlaceCardProps {
  place: Place;
  onSelect?: (place: Place) => void;
  onRemove?: (placeId: string) => void;
  isSelected?: boolean;
  showActions?: boolean;
  className?: string;
}

export const PlaceCard: React.FC<PlaceCardProps> = ({
  place,
  onSelect,
  onRemove,
  isSelected = false,
  showActions = false,
  className = ''
}) => {
  // Get the display name with proper fallback
  const getTypeDisplay = () => {
    if (place.primaryTypeDisplayName?.text) {
      return place.primaryTypeDisplayName.text;
    }
    return formatPrimaryType(place.primaryType);
  };

  const handleSelect = useCallback(() => {
    if (onSelect) {
      onSelect(place);
    }
  }, [place, onSelect]);

  const handleRemove = useCallback(() => {
    if (onRemove) {
      onRemove(place.id);
      // Remove from savedPlacesManager
      if (savedPlacesManager.hasPlace(place.id)) {
        savedPlacesManager.removePlace(place.id);
      }
    }
  }, [place.id, onRemove]);

  // Add marker to map when card is shown
  useEffect(() => {
    // Add to map if location exists
    if (place?.location && window.addPlaceToMap) {
      console.log('[PlaceCard] Adding place to map:', place);
      window.addPlaceToMap({
        latitude: place.location.latitude,
        longitude: place.location.longitude,
        title: typeof place.displayName === 'string' ? place.displayName : place.displayName.text,
        place // Pass the full place object for click handling
      });
    }
  }, [place]);

  return (
    <div className={`place-card w-[70%] mx-auto h-min shadow-md rounded-2xl overflow-hidden ${className}`}>
      <div className="bg-gray-200 h-48 flex items-center justify-center">
        {place.photos && place.photos[0] ? (
          <img
            src={`https://places.googleapis.com/v1/${place.photos[0].name}/media?maxHeightPx=192&maxWidthPx=400&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`}
            alt={typeof place.displayName === 'string' ? place.displayName : place.displayName.text}
            className="w-full h-full object-cover"
            onError={(e) => {
              console.log('[PlaceCard] Photo load failed for:', {
                id: place.id,
                name: typeof place.displayName === 'string' ? place.displayName : place.displayName.text
              });
              
              // First try using Place ID if available
              if (place.id) {
                const placePhotoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${place.id}&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`;
                e.currentTarget.src = placePhotoUrl;
                return;
              }

              // If Place ID photo fails, try refreshing place data
              e.currentTarget.parentElement?.classList.add('animate-pulse');
              searchPlaceByText(
                typeof place.displayName === 'string' ? place.displayName : place.displayName.text,
                place.location || { latitude: 0, longitude: 0 },
                'Singapore'
              ).then(freshPlace => {
                if (freshPlace && freshPlace.photos && freshPlace.photos[0]) {
                  console.log('[PlaceCard] Got fresh photo for:', {
                    id: place.id,
                    name: typeof place.displayName === 'string' ? place.displayName : place.displayName.text
                  });
                  e.currentTarget.parentElement?.classList.remove('animate-pulse');
                  e.currentTarget.src = `https://places.googleapis.com/v1/${freshPlace.photos[0].name}/media?maxHeightPx=192&maxWidthPx=400&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`;
                  if (savedPlacesManager.hasPlace(place.id)) {
                    savedPlacesManager.addPlace(freshPlace);
                  }
                } else {
                  e.currentTarget.style.display = 'none';
                  const noImageDiv = document.createElement('div');
                  noImageDiv.className = 'w-full h-full flex items-center justify-center bg-gray-300';
                  noImageDiv.innerHTML = '<span class="text-gray-500">No image available</span>';
                  e.currentTarget.parentElement?.appendChild(noImageDiv);
                }
              }).catch(error => {
                console.error('[PlaceCard] Error refreshing photo:', error);
                e.currentTarget.style.display = 'none';
                const noImageDiv = document.createElement('div');
                noImageDiv.className = 'w-full h-full flex items-center justify-center bg-gray-300';
                noImageDiv.innerHTML = '<span class="text-gray-500">No image available</span>';
                e.currentTarget.parentElement?.appendChild(noImageDiv);
              });
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-300">
            <span className="text-gray-500">No image available</span>
          </div>
        )}
      </div>

      <div className="p-4 bg-white">
        <h3 className="text-lg font-bold text-gray-900">
          {typeof place.displayName === 'string' 
            ? place.displayName 
            : place.displayName.text}
        </h3>
        <p className="text-sm text-gray-500 mb-3 font-medium">{getTypeDisplay()}</p>
        <p className="text-sm text-gray-600">{place.formattedAddress}</p>
      
        {showActions && (
          <div className="mt-4 flex justify-end gap-2">
            {!isSelected && onSelect && (
              <button
                onClick={handleSelect}
                className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors duration-200"
                aria-label={`Select ${place.displayName}`}
              >
                Select
              </button>
            )}
            {/* Temporarily commented out remove button 
            {onRemove && (
              <button
                onClick={handleRemove}
                className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors duration-200"
                aria-label={`Remove ${place.displayName}`}
              >
                Remove
              </button>
            )}
            */}
          </div>
        )}
      </div>
    </div>
  );
};