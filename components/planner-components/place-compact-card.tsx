import { Grip, X } from 'lucide-react'
import { Place } from '../../managers/types'
import Image from 'next/image'

interface PlaceCardProps {
  place: Place
  onDelete: (id: string) => void
}

export function PlaceCompactCard({ place, onDelete }: PlaceCardProps) {
  return (
    <div className="group flex items-center gap-3 rounded-lg border bg-card p-3 shadow-sm">
      <div className="flex cursor-grab items-center text-muted-foreground hover:text-foreground">
        <Grip className="h-5 w-5" />
      </div>
      
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md">
        <Image
          src="/placeholder.svg"
          alt={place.displayName.text}
          fill
          className="object-cover"
        />
      </div>
      
      <div className="flex flex-1 flex-col gap-1">
        <h3 className="font-medium leading-none">{place.displayName.text}</h3>
        <p className="text-sm text-muted-foreground">{place.primaryTypeDisplayName.text}</p>
        <p className="text-xs text-muted-foreground">{place.formattedAddress}</p>
      </div>
      
      <button
        onClick={() => onDelete(place.id)}
        className="invisible group-hover:visible"
        aria-label="Delete place"
      >
        <X className="h-5 w-5 text-muted-foreground hover:text-destructive" />
      </button>
    </div>
  )
}
