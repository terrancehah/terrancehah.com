import { Clock, ArrowLeftRight } from 'lucide-react'

interface TravelInfoProps {
  duration?: string;
  distance?: string;
}

export function TravelInfo({ duration = "30 mins", distance = "3.2 km" }: TravelInfoProps) {
  return (
    <div className="relative my-2 flex items-center gap-3 py-4 pl-4">
      <div className="absolute inset-y-2 left-1 w-0.5 bg-muted-foreground"></div>
      <div className="z-10 flex flex-col gap-1 text-sm text-muted-foreground">
        <div className="flex items-center gap-1">
          <Clock className="h-4 w-4" />
          <span>{duration}</span>
        </div>
        <div className="flex items-center gap-1">
          <ArrowLeftRight className="h-4 w-4" />
          <span>{distance}</span>
        </div>
      </div>
    </div>
  )
}
