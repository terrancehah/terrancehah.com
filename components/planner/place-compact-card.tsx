'use client'

import { useState } from 'react'
import { Grip, X, GripVertical } from 'lucide-react'
import { Place } from '@/utils/places-utils'
import Image from 'next/image'
import { cn } from '@/utils/cn'

interface PlaceCardProps {
  place: Place
  onDelete: (id: string) => void
  dragHandleProps?: any
  className?: string
}

export function PlaceCompactCard({ place, onDelete, dragHandleProps, className }: PlaceCardProps) {
  const [imageLoading, setImageLoading] = useState(true)
  const displayName = typeof place.displayName === 'string' ? place.displayName : place.displayName.text
  const typeDisplay = place.primaryTypeDisplayName?.text || place.primaryType

  const photoUrl = place.photos?.[0]?.name
    ? `https://places.googleapis.com/v1/${place.photos[0].name}/media?maxHeightPx=192&maxWidthPx=400&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`
    : '/images/placeholder-image.jpg'

  return (
    <div className={cn("group flex w-full items-center gap-3 rounded-lg border bg-card p-3 shadow-sm", className)}>
      {dragHandleProps && (
        <div {...dragHandleProps} className="text-gray-300">
          <GripVertical className="h-5 w-5" />
        </div>
      )}
      
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md">
        {imageLoading && (
          <div className="absolute inset-0 animate-pulse bg-muted" />
        )}
        <Image
          src={photoUrl}
          alt={displayName}
          fill
          className={cn(
            "object-cover",
            imageLoading ? "opacity-0" : "opacity-100 transition-opacity duration-200"
          )}
          onLoad={() => setImageLoading(false)}
          onError={(e) => {
            setImageLoading(false)
            // @ts-ignore - src exists on HTMLImageElement
            e.currentTarget.src = '/images/placeholder-image.jpg'
          }}
        />
      </div>
      
      <div className="flex flex-1 flex-col gap-1">
        <h3 className="font-medium text-base leading-none">{displayName}</h3>
        <p className="text-sm text-muted-foreground">{typeDisplay}</p>
        <p className="text-xs text-muted-foreground">{place.formattedAddress}</p>
      </div>
      
      <button
        onClick={() => onDelete(place.id)}
        className="invisible group-hover:visible"
        aria-label="Delete place"
      >
        <X className="h-5 w-5 text-muted-foreground hover:text-destructive hover:text-red-600 hover:bg-red-100 rounded-sm" />
      </button>
    </div>
  )
}
