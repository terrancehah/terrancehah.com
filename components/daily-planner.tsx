'use client'

import { useState, useEffect } from 'react'
import { DragDropContext, DropResult } from '@hello-pangea/dnd'
import { DaySection } from './planner-components/day-section'
import { Place } from '../utils/places-utils'
import { savedPlacesManager } from '../utils/places-utils'
import { getStoredSession } from '../utils/session-manager'

interface DayPlan {
  id: string
  date: string
  places: Place[]
}

export default function ItineraryPlanner() {
  const [days, setDays] = useState<DayPlan[]>([])

  // Initialize days with saved places
  useEffect(() => {
    const session = getStoredSession()
    if (!session) return

    const savedPlaces = savedPlacesManager.getPlaces()
    
    // Calculate date range
    const startDate = new Date(session.startDate)
    const endDate = new Date(session.endDate)
    const numberOfDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
    
    // Distribute places evenly across days
    const minPlacesPerDay = Math.floor(savedPlaces.length / numberOfDays)
    const extraPlaces = savedPlaces.length % numberOfDays
    
    let placeIndex = 0
    const initialDays = Array.from({ length: numberOfDays }, (_, dayIndex) => {
      // Calculate number of places for this day
      const placesForThisDay = dayIndex < extraPlaces ? minPlacesPerDay + 1 : minPlacesPerDay
      
      // Get places for this day and set their indices
      const dayPlaces = savedPlaces.slice(placeIndex, placeIndex + placesForThisDay)
        .map((place, orderIndex) => {
          place.dayIndex = dayIndex
          place.orderIndex = orderIndex
          savedPlacesManager.updatePlace(place)
          return place
        })
      placeIndex += placesForThisDay
      
      // Calculate date for this day
      const dayDate = new Date(startDate)
      dayDate.setDate(startDate.getDate() + dayIndex)
      
      return {
        id: `day-${dayIndex + 1}`,
        date: dayDate.toISOString().split('T')[0],
        places: dayPlaces
      }
    })
    
    setDays(initialDays)
  }, [])

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return

    const { source, destination } = result
    
    // Copy current days
    const newDays = [...days]
    
    // Same day, different position
    if (source.droppableId === destination.droppableId) {
      const dayIndex = days.findIndex(d => d.id === source.droppableId)
      const dayPlaces = [...days[dayIndex].places]
      const [removed] = dayPlaces.splice(source.index, 1)
      dayPlaces.splice(destination.index, 0, removed)
      newDays[dayIndex].places = dayPlaces

      // Update indices
      removed.dayIndex = dayIndex
      removed.orderIndex = destination.index
      savedPlacesManager.updatePlace(removed)
    } 
    // Different days
    else {
      const sourceDayIndex = days.findIndex(d => d.id === source.droppableId)
      const destDayIndex = days.findIndex(d => d.id === destination.droppableId)
      
      const sourcePlaces = [...days[sourceDayIndex].places]
      const destPlaces = [...days[destDayIndex].places]
      
      const [removed] = sourcePlaces.splice(source.index, 1)
      destPlaces.splice(destination.index, 0, removed)
      
      newDays[sourceDayIndex].places = sourcePlaces
      newDays[destDayIndex].places = destPlaces

      // Update indices
      removed.dayIndex = destDayIndex
      removed.orderIndex = destination.index
      savedPlacesManager.updatePlace(removed)
    }
    
    setDays(newDays)
  }

  const handleDeletePlace = (dayId: string, placeId: string) => {
    setDays(days.map(day => {
      if (day.id === dayId) {
        return {
          ...day,
          places: day.places.filter(place => place.id !== placeId)
        }
      }
      return day
    }))
    // Also remove from savedPlacesManager
    savedPlacesManager.removePlace(placeId)
  }

  return (
    <div className="flex h-screen">
      <div className="w-1/2 overflow-auto border-r bg-background p-6">
        <div className="h-[200px] border-b">
          {/* Header placeholder */}
        </div>
        
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="space-y-6 py-6">
            {days.map((day, index) => (
              <DaySection
                key={day.id}
                day={day}
                index={index}
                onDeletePlace={handleDeletePlace}
              />
            ))}
          </div>
        </DragDropContext>
      </div>
      
      <div className="w-1/2 bg-muted">
        {/* Map placeholder */}
      </div>
    </div>
  )
}
