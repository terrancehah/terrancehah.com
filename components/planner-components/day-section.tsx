'use client'

import { useState } from 'react'
import { Droppable, Draggable, DragDropContext } from '@hello-pangea/dnd'
import { DayPlan } from '../daily-planner'
import { Place } from '../../utils/places-utils'
import { PlaceCompactCard } from './place-compact-card'
import { Search, Loader2, GripVertical, Clock, MoveHorizontal, ArrowRight } from 'lucide-react'
import { Input } from '../ui/input'
import { searchPlaceByText } from '../../utils/places-utils'
import { getStoredSession } from '../../utils/session-manager'
import { cn } from '../../utils/cn'
import { Fragment } from 'react'
import { TravelInfo } from './travel-info'

interface DaySectionProps {
  day: DayPlan
  index: number
  onDeletePlace: (dayId: string, placeId: string) => void
  onAddPlace: (dayId: string, place: Place) => void
  onPlacesChange: (dayId: string, places: Place[]) => void
  className?: string
  isDragging?: boolean
}

export function DaySection({ day, index, onDeletePlace, onAddPlace, onPlacesChange, className = '', isDragging = false }: DaySectionProps) {
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

  const onDragEnd = (result: any) => {
    if (!result.destination) return;

    const newPlaces = [...day.places];
    const [movedPlace] = newPlaces.splice(result.source.index, 1);
    newPlaces.splice(result.destination.index, 0, movedPlace);
    
    onPlacesChange(day.id, newPlaces);
  };

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className={`rounded-lg border bg-card p-4 shadow-sm ${className}`}>
        <h2 className="mb-3 ml-1 text-lg font-semibold">Day {index + 1} ({formattedDate})</h2>
        
        <div className="flex">
          {/* Places column with drag and drop */}
          <div className="flex-1">
            <Droppable droppableId={day.id}>
              {(provided) => (
                <div
                  {...provided.droppableProps}
                  ref={provided.innerRef}
                  className="space-y-4"
                >
                  {day.places.map((place, placeIndex) => (
                    <Draggable key={place.id} draggableId={place.id} index={placeIndex}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          className={cn(
                            'rounded-lg bg-white shadow-sm max-h-[100px] overflow-hidden',
                            snapshot.isDragging && 'ring-2 ring-primary ring-offset-2 z-30'
                          )}
                        >
                          <div className="group relative">
                            <div className="absolute left-3 top-1/2 -translate-y-1/2">
                              <GripVertical className="h-7 w-5 text-gray-400 opacity-60 transition-opacity group-hover:opacity-100" />
                            </div>
                            <PlaceCompactCard place={place} className="pl-10" onDelete={() => onDeletePlace(day.id, place.id)} />
                          </div>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </div>

          {/* Travel info column with connecting lines */}
          <div className="w-28 relative flex flex-col gap-y-7 my-auto">
            {day.places.slice(0, -1).map((place, idx) => (
              <div key={`travel-${place.id}`} className="relative ml-[15px] align-middle flex" style={{ height: '88px' }}>
                {/* Travel info centered between places */}
                <div className="my-auto">
                  <TravelInfo 
                    duration="30 mins"
                    distance="3.2 km"
                    isLoading={false}
                    className="pointer-events-none"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        
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
    </DragDropContext>
  )
}
