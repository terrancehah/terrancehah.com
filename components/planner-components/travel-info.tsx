import { Clock, ArrowLeftRight } from 'lucide-react'
import { cn } from '../../utils/cn'

interface TravelInfoProps {
  duration?: string
  distance?: string
  isLoading?: boolean
  className?: string
}

export function TravelInfo({ 
  duration = "30 mins", 
  distance = "3.2 km",
  isLoading = false,
  className
}: TravelInfoProps) {
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
