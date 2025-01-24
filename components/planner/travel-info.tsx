import { Clock, ArrowLeftRight } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useEffect, useState } from 'react'
import { Place } from '@/utils/places-utils'
import { travelInfoManager } from '@/utils/travel-info-utils'

interface TravelInfoProps {
  place: Place
  nextPlace: Place
  className?: string
}

export function TravelInfo({ place, nextPlace, className }: TravelInfoProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [duration, setDuration] = useState('--')
  const [distance, setDistance] = useState('--')

  useEffect(() => {
    const isMounted = { current: true }; // Track mount state

    // Clear all routes involving these places
    if (place?.id && nextPlace?.id) {
      // First clear all routes in the manager
      travelInfoManager.clearRoutesForPlaces([place, nextPlace]);
      // Then notify map to remove the visual routes
      window.dispatchEvent(new CustomEvent('travelinfo-hidden', {
        detail: { fromId: place.id, toId: nextPlace.id }
      }));
    }

    async function fetchTravelInfo() {
      try {
        console.log('[TravelInfo] Fetching info for:', {
          from: place?.displayName,
          to: nextPlace?.displayName,
          fromId: place?.id,
          toId: nextPlace?.id
        });
        
        setIsLoading(true)
        const info = await travelInfoManager.getTravelInfo(place, nextPlace)
        
        // Only proceed if still mounted
        if (!isMounted.current) {
          console.log('[TravelInfo] Component unmounted, skipping update');
          return;
        }

        console.log('[TravelInfo] Received info:', info);
        
        if (info) {
          setDuration(info.duration)
          setDistance(info.distance)
          // Only notify for display if we have valid info AND component is still mounted
          if (!info.error && place?.id && nextPlace?.id && isMounted.current) {
            window.dispatchEvent(new CustomEvent('travelinfo-displayed', { 
              detail: { fromId: place.id, toId: nextPlace.id }
            }));
          }
        }
      } catch (error) {
        console.error('[TravelInfo] Error:', error)
      } finally {
        if (isMounted.current) {
          setIsLoading(false)
        }
      }
    }

    if (place?.location && nextPlace?.location) {
      console.log('[TravelInfo] Starting fetch for:', {
        hasLocation: {
          from: !!place?.location,
          to: !!nextPlace?.location
        }
      });
      fetchTravelInfo()
    } else {
      console.log('[TravelInfo] Missing location:', {
        from: place?.displayName,
        to: nextPlace?.displayName,
        fromLocation: place?.location,
        toLocation: nextPlace?.location
      });
    }

    // Cleanup when component unmounts or places change
    return () => {
      isMounted.current = false;
      if (place?.id && nextPlace?.id) {
        window.dispatchEvent(new CustomEvent('travelinfo-hidden', {
          detail: { fromId: place.id, toId: nextPlace.id }
        }));
      }
    };
  }, [place?.id, nextPlace?.id, place?.location?.latitude, place?.location?.longitude, nextPlace?.location?.latitude, nextPlace?.location?.longitude])

  return (
    <div className={cn(
      "relative my-2 flex items-center gap-3 py-4",
      "transition-opacity duration-200",
      className
    )}>
      <div className="absolute inset-y-2 w-0.5 bg-muted-foreground"></div>
      <div className="z-10 flex flex-col gap-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <Clock className={cn("h-4 w-4", isLoading && "animate-pulse")} />
          {isLoading ? (
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
          ) : (
            <span>{duration}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ArrowLeftRight className={cn("h-4 w-4", isLoading && "animate-pulse")} />
          {isLoading ? (
            <div className="h-4 w-14 animate-pulse rounded bg-muted" />
          ) : (
            <span>{distance}</span>
          )}
        </div>
      </div>
    </div>
  )
}
