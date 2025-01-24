import { useEffect, useRef, useState } from 'react'
import { Input } from '../ui/input'
import { Search, Loader2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import { getStoredSession } from '@/utils/session-manager'
import { Place, searchPlaceByText } from '@/utils/places-utils'

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
    if (!session?.location?.latitude || !session?.location?.longitude || !window.google || !autocompleteInputRef.current) {
      return;
    }

    // Capture the location in the outer scope
    const location = session.location;

    const autocomplete = new window.google.maps.places.Autocomplete(autocompleteInputRef.current, {
      types: ['establishment'],
      bounds: new window.google.maps.LatLngBounds(
        new window.google.maps.LatLng(location.latitude - 0.1, location.longitude - 0.1),
        new window.google.maps.LatLng(location.latitude + 0.1, location.longitude + 0.1)
      ),
      strictBounds: true
    })

    autocomplete.addListener('place_changed', async () => {
      const place = autocomplete.getPlace()
      console.log('Google Place result:', place)
      
      if (!place?.place_id) {
        console.error('Invalid place selected:', place)
        setSearchError('Invalid place selected')
        return
      }

      setIsSearching(true)
      try {
        // Use Places Service to get full details
        const service = new window.google.maps.places.PlacesService(document.createElement('div'))
        
        service.getDetails(
          {
            placeId: place.place_id,
            fields: ['name', 'geometry']
          },
          async (detailedPlace, status) => {
            if (status !== 'OK' || !detailedPlace?.name) {
              console.error('Failed to get place details:', status)
              setSearchError('Failed to get place details')
              setIsSearching(false)
              return
            }

            console.log('Searching with place name:', detailedPlace.name)
            const fullPlace = await searchPlaceByText(
              detailedPlace.name,
              {
                latitude: location.latitude,
                longitude: location.longitude
              },
              session.destination
            )
            
            if (fullPlace) {
              onPlaceSelected(fullPlace)
              setSearchText('')
            }
            setIsSearching(false)
          }
        )
      } catch (error) {
        console.error('Error searching for place:', error)
        setSearchError('Failed to add place')
        setIsSearching(false)
      }
    })
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
