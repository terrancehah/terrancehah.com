import { useEffect, useRef, useState } from 'react'
import { Input } from '../ui/input'
import { Search, Loader2 } from 'lucide-react'
import { cn } from '../../utils/cn'
import { getStoredSession } from '../../utils/session-manager'
import { Place } from '../../utils/places-utils'

interface PlaceSearchProps {
  onPlaceSelected: (place: Place) => void
  className?: string
  disabled?: boolean
}

export function PlaceSearch({ onPlaceSelected, className = '', disabled = false }: PlaceSearchProps) {
  const [searchText, setSearchText] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const autocompleteInputRef = useRef<HTMLInputElement>(null)
  const session = getStoredSession()

  useEffect(() => {
    if (typeof window !== 'undefined' && window.google && autocompleteInputRef.current && session?.location) {
      const autocomplete = new window.google.maps.places.Autocomplete(autocompleteInputRef.current, {
        types: ['establishment'],
        bounds: new window.google.maps.LatLngBounds(
          new window.google.maps.LatLng(session.location.latitude - 0.1, session.location.longitude - 0.1),
          new window.google.maps.LatLng(session.location.latitude + 0.1, session.location.longitude + 0.1)
        ),
        strictBounds: true,
        fields: ['place_id', 'name', 'types', 'formatted_address', 'geometry', 'photos']
      })

      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace()
        if (place.geometry) {
          const newPlace: Place = {
            id: place.place_id || `place-${Date.now()}`,
            name: place.name || undefined,
            displayName: place.name || '',
            primaryType: place.types?.[0] || 'establishment',
            primaryTypeDisplayName: {
              text: place.types?.[0] || 'establishment',
              languageCode: 'en'
            },
            formattedAddress: place.formatted_address,
            photos: place.photos?.map(photo => ({
              name: photo.getUrl?.() || '',
              widthPx: photo.width,
              heightPx: photo.height,
            })) || [],
            location: {
              latitude: place.geometry.location?.lat() || 0,
              longitude: place.geometry.location?.lng() || 0
            },
            dayIndex: -1,
            orderIndex: -1
          }
          onPlaceSelected(newPlace)
          setSearchText('')
        }
      })
    }
  }, [session, onPlaceSelected])

  return (
    <div className="relative">
      {isSearching ? (
        <Loader2 className="absolute left-2 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
      )}
      <Input
        ref={autocompleteInputRef}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder={isSearching ? "Searching..." : "Search for a place to add..."}
        className={cn("pl-8", isSearching && "text-muted-foreground", className)}
        disabled={disabled || isSearching}
      />
      {searchError && (
        <p className="mt-1 text-sm text-destructive">{searchError}</p>
      )}
    </div>
  )
}
