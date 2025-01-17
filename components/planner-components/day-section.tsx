'use client'

import { Draggable, Droppable } from '@hello-pangea/dnd'
import { Place, DayPlan } from '../../managers/types'
import { PlaceCompactCard } from './place-compact-card'
import { TravelInfo } from './travel-info'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface DaySectionProps {
  day: {
    id: string
    date: string
    places: Place[]
  }
  index: number
  onDeletePlace: (dayId: string, placeId: string) => void
}

export function DaySection({ day, index, onDeletePlace }: DaySectionProps) {
  // Format date to display like "Day 1 (Jan 21)"
  const formattedDate = new Date(day.date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold">Day {index + 1} ({formattedDate})</h2>
      
      <Droppable droppableId={day.id}>
        {(provided) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="space-y-0"
          >
            {day.places.map((place, placeIndex) => (
              <div key={place.id}>
                <Draggable draggableId={place.id} index={placeIndex}>
                  {(provided) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      {...provided.dragHandleProps}
                    >
                      <PlaceCompactCard
                        place={place}
                        onDelete={(placeId) => onDeletePlace(day.id, placeId)}
                      />
                    </div>
                  )}
                </Draggable>
                {placeIndex < day.places.length - 1 && (
                  <TravelInfo 
                    duration={placeIndex === 0 ? "45 mins" : "30 mins"} 
                    distance={placeIndex === 0 ? "4.5 km" : "2.8 km"} 
                  />
                )}
              </div>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>

      <div className="mt-4">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search for a place to add..."
            className="pl-8"
          />
        </div>
      </div>
    </div>
  )
}
