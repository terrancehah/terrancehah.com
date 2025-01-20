import { Clock, ArrowLeftRight } from 'lucide-react'
import { cn } from '../../utils/cn'
import { useEffect, useState } from 'react'
import { Place } from '../../utils/places-utils'
import { travelInfoManager } from '../../utils/travel-info-utils'

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
    async function fetchTravelInfo() {
      try {
        setIsLoading(true)
        const info = await travelInfoManager.getTravelInfo(place, nextPlace)
        if (info) {
          setDuration(info.duration)
          setDistance(info.distance)
        }
      } catch (error) {
        console.error('[TravelInfo] Error:', error)
      } finally {
        setIsLoading(false)
      }
    }

    if (place?.location && nextPlace?.location) {
      fetchTravelInfo()
    }
  }, [place?.location, nextPlace?.location])

  return (
    <div className={cn(
      "relative my-2 flex items-center gap-3 py-4",
      "transition-opacity duration-200",
      className
    )}>
      <div className="absolute inset-y-2 w-0.5 bg-muted-foreground"></div>
      <div className="z-10 flex flex-col gap-1 text-sm text-muted-foreground">
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
