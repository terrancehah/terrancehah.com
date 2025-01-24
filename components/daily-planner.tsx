'use client'

import { useState, useEffect } from 'react'
import { DragDropContext, DropResult } from '@hello-pangea/dnd'
import { DaySection } from '../components/planner/day-section'
import { Place } from '@/utils/places-utils'
import { savedPlacesManager } from '@/utils/places-utils'
import { getStoredSession } from '@/utils/session-manager'
import { ChevronUpIcon, ChevronDownIcon } from 'lucide-react';
import { TravelDetails } from '../managers/types'
import react from 'react'
import { travelInfoManager } from '@/utils/travel-info-utils'

export interface DayPlan {
  id: string
  date: string
  places: Place[]
}

interface ItineraryPlannerProps {
  onPlaceRemoved: (placeId: string) => void
}

export default function ItineraryPlanner({ onPlaceRemoved }: ItineraryPlannerProps) {
  const [days, setDays] = useState<DayPlan[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCollapsed, setIsCollapsed] = useState(true)
  const [currentDetails, setCurrentDetails] = useState<TravelDetails>({
    destination: '',
    startDate: '',
    endDate: '',
    preferences: [],
    budget: '',
    language: '',
    transport: [],
    location: {
      latitude: 0,
      longitude: 0
    }
  })
  const [isDragging, setIsDragging] = useState(false)

  // Initialize days with saved places
  useEffect(() => {
    const session = getStoredSession()
    if (!session) {
      setIsLoading(false)
      return
    }

    // Set current details from session
    setCurrentDetails({
      destination: session.destination,
      startDate: session.startDate,
      endDate: session.endDate,
      preferences: session.preferences,
      budget: session.budget || '',
      language: session.language || '',
      transport: session.transport || [],
      // Use session location for city coordinates
      location: session.location || { latitude: 0, longitude: 0 }
    })

    // Calculate date range
    const startDate = new Date(session.startDate)
    const endDate = new Date(session.endDate)
    const numberOfDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
    
    // Distribute places evenly across days
    const minPlacesPerDay = Math.floor(savedPlacesManager.getPlaces().length / numberOfDays)
    const extraPlaces = savedPlacesManager.getPlaces().length % numberOfDays
    
    let placeIndex = 0
    const initialDays = Array.from({ length: numberOfDays }, (_, dayIndex) => {
      // Calculate number of places for this day
      const placesForThisDay = dayIndex < extraPlaces ? minPlacesPerDay + 1 : minPlacesPerDay
      
      // Get places for this day and set their indices
      const dayPlaces = savedPlacesManager.getPlaces().slice(placeIndex, placeIndex + placesForThisDay)
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
    setIsLoading(false)
  }, [])

  const onDragStart = () => {
    setIsDragging(true)
  }

  const onDragEnd = (result: DropResult) => {
    setIsDragging(false);
    
    if (!result.destination) return;

    const { source, destination } = result;
    
    // If dropped in same day and same position
    if (source.droppableId === destination.droppableId && source.index === destination.index) {
      return;
    }

    // Find the source and destination days
    const sourceDayIndex = days.findIndex(day => day.id === source.droppableId);
    const destDayIndex = days.findIndex(day => day.id === destination.droppableId);
    
    if (sourceDayIndex === -1 || destDayIndex === -1) return;

    const newDays = [...days];
    const sourceDay = { ...newDays[sourceDayIndex] };
    const destDay = sourceDayIndex === destDayIndex ? sourceDay : { ...newDays[destDayIndex] };

    // Remove from source day
    const [movedPlace] = sourceDay.places.splice(source.index, 1);
    
    // Update the moved place's indices
    movedPlace.dayIndex = destDayIndex;
    movedPlace.orderIndex = destination.index;
    
    // Add to destination day
    destDay.places.splice(destination.index, 0, movedPlace);

    // Update order indices for source day places
    sourceDay.places = sourceDay.places.map((place, idx) => ({
      ...place,
      dayIndex: sourceDayIndex,
      orderIndex: idx
    }));

    if (sourceDayIndex !== destDayIndex) {
      // Update order indices for destination day places
      destDay.places = destDay.places.map((place, idx) => ({
        ...place,
        dayIndex: destDayIndex,
        orderIndex: idx
      }));
    }

    // Update the days array
    newDays[sourceDayIndex] = sourceDay;
    if (sourceDayIndex !== destDayIndex) {
      newDays[destDayIndex] = destDay;
    }

    // Update state
    setDays(newDays);
    
    // Get all affected places in their final order
    const allAffectedPlaces = [
      ...sourceDay.places,  // Source day places with updated indices
      ...(sourceDayIndex !== destDayIndex ? destDay.places : [])  // Destination day places if different
    ];

    // Clear travel info cache for all affected places at once
    travelInfoManager.clearRoutesForPlaces(allAffectedPlaces);

    // Update all places at once
    savedPlacesManager.updatePlaces(allAffectedPlaces);
    
    // No need to dispatch event manually as updatePlaces will trigger _notifyChange
  };

  const handleDeletePlace = (dayId: string, placeId: string) => {
    const day = days.find(d => d.id === dayId);
    if (day) {
      // Get adjacent places to clear their routes
      const placeIndex = day.places.findIndex(p => p.id === placeId);
      const placesToClear = [];
      
      // Get the place being deleted
      const place = day.places[placeIndex];
      if (place) placesToClear.push(place);
      
      // Get previous place if exists
      if (placeIndex > 0) {
        placesToClear.push(day.places[placeIndex - 1]);
      }
      
      // Get next place if exists
      if (placeIndex < day.places.length - 1) {
        placesToClear.push(day.places[placeIndex + 1]);
      }

      // Clear routes for all affected places at once
      travelInfoManager.clearRoutesForPlaces(placesToClear);
    }

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
    onPlaceRemoved(placeId)
  }

  const handleAddPlace = (dayId: string, place: Place) => {
    setDays(days.map(day => {
      if (day.id === dayId) {
        // Add to end of day's places
        const orderIndex = day.places.length
        place.dayIndex = days.indexOf(day)
        place.orderIndex = orderIndex

        // Clear travel info cache for adjacent places
        const placesToClear = [place];
        if (day.places.length > 0) {
          // Add last place in day (will be connected to new place)
          placesToClear.push(day.places[day.places.length - 1]);
        }
        
        // Clear routes for all affected places at once
        travelInfoManager.clearRoutesForPlaces(placesToClear);

        return {
          ...day,
          places: [...day.places, place]
        }
      }
      return day
    }))
    
    // Add to savedPlacesManager
    savedPlacesManager.addPlace(place)
  }

  const handlePlacesChange = (dayId: string, newPlaces: Place[]) => {
    // Update days state
    setDays(days.map(day => {
      if (day.id === dayId) {
        // Update all places' order indices sequentially
        const updatedPlaces = newPlaces.map((place, idx) => ({
          ...place,
          orderIndex: idx
        }));
        // Update in savedPlacesManager
        updatedPlaces.forEach(place => {
          savedPlacesManager.updatePlace(place);
        });
        return { ...day, places: updatedPlaces };
      }
      return day;
    }));
  };

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="flex h-full flex-col">
        
        {/* Header */}
        <div className="bg-background border-b border-border shadow-sm transition-all duration-300 ease-in-out">
          <div className=" mx-auto p-2 px-6 relative">
            <div 
              className={`transition-all duration-300 ease-in-out ${
                isCollapsed ? 'max-h-12' : 'max-h-[500px]'
              }`}
            >
              <h1 className={`font-semibold text-foreground ${isCollapsed ? 'text-lg mb-0' : 'text-lg mb-2'}`}>
                Trip to {currentDetails.destination}
              </h1>
              
              {isCollapsed ? (

                // Collapsed mode
                <div className="flex flex-col gap-y-1.5 text-muted-foreground">
                  {/* Keeping this empty as requested */}
                </div>
              ) : (

                // Expanded mode
                <div className="grid grid-cols-2 gap-x-16 gap-y-4">

                  {/* Date */}
                  <div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                      </svg>
                      Date
                    </div>
                    <div className="text-foreground text-sm">{currentDetails.startDate} to {currentDetails.endDate}</div>
                  </div>

                  <div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                      </svg>
                      Language
                    </div>
                    <div className="text-foreground text-sm">{currentDetails.language}</div>
                  </div>
                  
                  <div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                      </svg>
                      Preferences
                    </div>
                    <div className="text-foreground text-sm">
                      {currentDetails.preferences?.join(', ') || '-'}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Budget
                    </div>
                    <div className="text-foreground text-sm">
                      {currentDetails.budget || '-'}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="absolute bottom-0 left-1/2 transform -translate-x-1/2 px-2 py-0.5 mb-2 text-gray-500 hover:text-black hover:bg-slate-200 transition-colors bg-slate-50 rounded-full duration-200 focus:outline-none"
              aria-label={isCollapsed ? "Expand header" : "Collapse header"}
            >
              {isCollapsed ? (
                <ChevronDownIcon className="h-6 w-6" />
              ) : (
                <ChevronUpIcon className="h-6 w-6" />
              )}
            </button>
          </div>
        </div>
        
        {/* Days list */}
        <div className="flex-1 overflow-y-scroll p-4 space-y-4">
          {isLoading ? (
            // Loading skeleton
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse space-y-4 rounded-lg border bg-card p-4">
                <div className="h-6 w-1/4 rounded bg-muted" />
                <div className="space-y-3">
                  {Array.from({ length: 2 }).map((_, j) => (
                    <div key={j} className="flex items-center gap-3">
                      <div className="h-16 w-16 rounded-md bg-muted" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-1/2 rounded bg-muted" />
                        <div className="h-3 w-1/3 rounded bg-muted" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            days.map((day, index) => (
              <DaySection
                key={day.id}
                day={day}
                index={index}
                onDeletePlace={handleDeletePlace}
                onAddPlace={handleAddPlace}
                onPlacesChange={handlePlacesChange}
                isDragging={isDragging}
              />
            ))
          )}
        </div>
      </div>
    </DragDropContext>
  )
}
