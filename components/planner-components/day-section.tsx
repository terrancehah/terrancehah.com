'use client'

import { useState } from 'react'
import { Droppable, Draggable } from '@hello-pangea/dnd'
import { DayPlan } from '../daily-planner'
import { Place } from '../../utils/places-utils'
import { PlaceCompactCard } from './place-compact-card'
import { Search, Loader2, GripVertical, Clock, MoveHorizontal, ArrowRight } from 'lucide-react'
import { Input } from '../ui/input'
import { searchPlaceByText } from '../../utils/places-utils'
import { getStoredSession } from '../../utils/session-manager'
import { cn } from '../../utils/cn'
import { Fragment } from 'react'

interface DaySectionProps {
  day: DayPlan
  index: number
  onDeletePlace: (dayId: string, placeId: string) => void
  onAddPlace: (dayId: string, place: Place) => void
  className?: string
  isDragging?: boolean
}

interface TravelInfoProps {
  place: Place
  nextPlace: Place
  isLoading?: boolean
  className?: string
}

function TravelInfo({ place, nextPlace, isLoading, className }: TravelInfoProps) {
  return (
    <div className={`relative ml-[52px] flex flex-col gap-1 text-sm text-gray-500 ${className}`}>
      <div className="absolute -left-[18px] top-0 h-full w-px bg-gray-200" />
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4" />
        <div className="h-4 w-16 animate-pulse rounded bg-gray-200" />
      </div>
      <div className="flex items-center gap-2">
        <MoveHorizontal className="h-4 w-4" />
        <div className="h-4 w-16 animate-pulse rounded bg-gray-200" />
      </div>
    </div>
  )
}

export function DaySection({ day, index, onDeletePlace, onAddPlace, className = '', isDragging = false }: DaySectionProps) {
  const [searchText, setSearchText] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  
  // Format date to display like "Day 1 (Jan 21)" or "Day 1 (Jan 21, 2025)" if different year
  const date = new Date(day.date)
  const today = new Date()
  const formattedDate = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() && { year: 'numeric' })
  })

  const handleSearch = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchText.trim() && !isSearching) {
      setSearchError('')
      const session = getStoredSession()
      if (session && session.savedPlaces.length > 0) {
        setIsSearching(true)
        const firstPlace = session.savedPlaces[0]
        const location = firstPlace.location
        if (location) {
          try {
            // Add timeout to prevent infinite loading
            const timeoutPromise = new Promise<Place>((_, reject) => 
              setTimeout(() => reject(new Error('Search timeout')), 10000)
            );
            const searchPromise = searchPlaceByText(
              searchText,
              location,
              session.destination
            );
            
            const place = await Promise.race<Place | null>([searchPromise, timeoutPromise]);
            if (place) {
              onAddPlace(day.id, place)
              setSearchText('')
            } else {
              setSearchError('No places found')
            }
          } catch (error) {
            console.error('[handleSearch] Error:', error)
            setSearchError(error instanceof Error ? error.message : 'Failed to search place')
          } finally {
            setIsSearching(false)
          }
        } else {
          setIsSearching(false)
          setSearchError('Invalid location data')
        }
      }
    }
  }

  return (
    <div className={`rounded-lg border bg-card p-4 shadow-sm ${className}`}>
      <h2 className="mb-3 ml-1 text-lg font-semibold">Day {index + 1} ({formattedDate})</h2>
      
      <Droppable droppableId={day.id}>
        {(provided) => (
          <div
            {...provided.droppableProps}
            ref={provided.innerRef}
            className="flex flex-col gap-4"
          >
            {day.places.map((place, placeIndex) => (
              <Fragment key={place.id}>
                <Draggable draggableId={place.id} index={placeIndex}>
                  {(provided, snapshot) => (
                    
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      className={cn(
                        'flex flex-col rounded-lg bg-white  shadow-sm',
                        snapshot.isDragging && 'z-10'
                      )}
                    >

                      <div className="group relative">

                        <div {...provided.dragHandleProps} className="absolute left-3 top-1/2 -translate-y-1/2">
                          <GripVertical className="h-7 w-5 text-gray-400 opacity-60 transition-opacity group-hover:opacity-100" />
                        </div>

                        <PlaceCompactCard place={place} className="pl-10" onDelete={() => onDeletePlace(day.id, place.id)} />
                      </div>
                    </div>
                  )}
                </Draggable>
                {placeIndex < day.places.length - 1 && !isDragging && (
                  <TravelInfo 
                    isLoading={true}
                    className="mx-4" 
                    place={place} 
                    nextPlace={day.places[placeIndex + 1]} 
                  />
                )}
              </Fragment>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>

      <div className="mt-4">
        <div className="relative">
          {isSearching ? (
            <Loader2 className="absolute left-2 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          )}
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={handleSearch}
            placeholder={isSearching ? "Searching..." : "Search for a place to add..."}
            className={cn("pl-8", isSearching && "text-muted-foreground")}
            disabled={isSearching}
          />
          {searchError && (
            <p className="mt-1 text-sm text-destructive">{searchError}</p>
          )}
        </div>
      </div>
    </div>
  )
}
