"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "../components/ui/button"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { Steps } from "../components/ui/steps"
import { useRouter } from "next/navigation"
import { MapPin, Calendar, Heart, Wallet, Languages, Trees, Soup, ShoppingBag, Ship, Palette } from "lucide-react"
import flatpickr from "flatpickr"
import type { Instance } from "flatpickr/dist/types/instance"
import "flatpickr/dist/flatpickr.min.css"
import Image from "next/image"
import Head from "next/head"
import { TravelPreference, TravelSession } from '../managers/types'
import { initializeSession, generateSessionId, safeStorageOp, getStoredSession, SESSION_CONFIG } from '../utils/session-manager'
import LoadingSpinner from '../components/LoadingSpinner'
import Link from "next/link"

// Add Google Maps types
declare global {
  interface Window {
    google: typeof google;
    initAutocomplete?: () => void;
  }
}

type FormData = {
  destination: string
  startDate: string
  endDate: string
  preferences: TravelPreference[]
  budget: string
}

export default function TravelFormPage() {
  const [loading, setLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [formData, setFormData] = useState<FormData>({
    destination: "",
    startDate: "",
    endDate: "",
    preferences: [],
    budget: ""
  })

  const destinationRef = useRef<HTMLInputElement>(null)
  const dateRangeRef = useRef<HTMLInputElement>(null)
  const budgetRef = useRef<HTMLSelectElement>(null)

  // Define steps configuration
  const steps = [
    {
      number: 1,
      title: "Destination",
      icon: MapPin
    },
    {
      number: 2,
      title: "Travel Dates",
      icon: Calendar
    },
    {
      number: 3,
      title: "Preferences",
      icon: Heart
    },
    {
      number: 4,
      title: "Budget",
      icon: Wallet
    }
  ]

  useEffect(() => {
    // Initialize Google Places Autocomplete
    const script = document.createElement("script")
    script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&callback=initAutocomplete`
    script.async = true
    script.defer = true

    window.initAutocomplete = () => {
      if (destinationRef.current) {
        const autocomplete = new window.google.maps.places.Autocomplete(destinationRef.current, {
          types: ["(cities)"]
        })

        autocomplete.addListener("place_changed", () => {
          const place = autocomplete.getPlace()
          const destination = place.formatted_address || ""
          if (destinationRef.current) {
            destinationRef.current.value = destination
            setFormData((prev: FormData) => ({
              ...prev,
              destination
            }))
          }
        })
      }
    }

    document.head.appendChild(script)

    return () => {
      document.head.removeChild(script)
      if (window.initAutocomplete) {
        delete window.initAutocomplete
      }
    }
  }, [])

  useEffect(() => {
    if (currentStep === 2 && dateRangeRef.current) {
      // Cleanup any existing flatpickr instance
      const existingInstance = (dateRangeRef.current as any)._flatpickr
      if (existingInstance) {
        existingInstance.destroy()
      }

      // Initialize new flatpickr instance
      const fp = flatpickr(dateRangeRef.current, {
        mode: "range",
        dateFormat: "Y-m-d",
        minDate: "today",
        onChange: (selectedDates, dateStr, instance) => {
          try {
            // When user starts a new selection, reset maxDate
            if (selectedDates.length === 0) {
              instance.set("maxDate", null);
              console.log('Reset date constraints for new selection');
              return;
            }

            // When first date is selected, set maxDate to 5 days ahead
            if (selectedDates.length === 1) {
              const maxDate = new Date(selectedDates[0].getTime() + (4 * 24 * 60 * 60 * 1000));
              instance.set("maxDate", maxDate);
              console.log('Set max date to:', maxDate.toISOString());
              return;
            }
            
            // When both dates are selected
            if (selectedDates.length === 2) {
              const formatDate = (date: Date) => {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
              };

              const startDate = formatDate(selectedDates[0]);
              const endDate = formatDate(selectedDates[1]);
              
              // Validate date range
              const diffDays = Math.ceil(
                (selectedDates[1].getTime() - selectedDates[0].getTime()) / 
                (1000 * 60 * 60 * 24)
              ) + 1;
              
              if (diffDays > 5) {
                console.warn('Invalid date range selected:', diffDays, 'days');
                return;
              }
              
              console.log('Selected dates:', { startDate, endDate, diffDays });
              setFormData(prev => ({
                ...prev,
                startDate,
                endDate
              }));

              // Reset maxDate after successful selection to allow reselection
              instance.set("maxDate", null);
            }
          } catch (error) {
            console.error('Error handling date selection:', error);
            // Reset the date picker on error
            instance.clear();
            instance.set("maxDate", null);
          }
        }
      })

      // Cleanup on unmount
      return () => {
        fp.destroy()
      }
    }
  }, [currentStep])

  const handlePreferenceToggle = (preference: TravelPreference) => {
    setFormData((prev) => {
      const preferences = prev.preferences.includes(preference)
        ? prev.preferences.filter((p) => p !== preference)
        : [...prev.preferences, preference]
      return { ...prev, preferences }
    })
  }

  const handleSubmit = async () => {
    setLoading(true)

    // Get form values
    const city = formData.destination
    const formattedStartDate = formData.startDate
    const formattedEndDate = formData.endDate
    const preferences = formData.preferences
    const budget = formData.budget

    console.log('Form Values:', {
      city,
      formattedStartDate,
      formattedEndDate,
      preferences,
      budget
    })

    if (!city || !formattedStartDate || !formattedEndDate || preferences.length === 0) {
      alert('Please fill in all required fields and select at least one travel preference')
      setLoading(false)
      return
    }

    try {
      const now = Date.now()
      const sessionId = generateSessionId()
      
      // Create new session with form values
      const session: TravelSession = {
        // Session info
        sessionId,
        startTime: now,
        lastActive: now,
        expiresAt: now + SESSION_CONFIG.ABSOLUTE_TIMEOUT,

        // Travel details
        destination: city,
        startDate: formattedStartDate,
        endDate: formattedEndDate,
        preferences: preferences,
        budget: budget || '',
        language: 'en', // Default to English
        transport: [],

        // Places
        savedPlaces: [],
        currentStage: 1,

        // Metrics
        totalPrompts: 0,
        stagePrompts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        savedPlacesCount: 0,

        // Payment
        isPaid: false,
        paymentReference: `session_${sessionId}`
      }

      // Use session manager's safe storage methods with verification
      console.log('About to store session:', session)
      const storageSuccess = safeStorageOp(() => {
        window.sessionStorage.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session))
        // Verify write by reading back immediately
        const written = window.sessionStorage.getItem(SESSION_CONFIG.STORAGE_KEY)
        const parsed = written ? JSON.parse(written) as TravelSession : null
        console.log('Immediate read-back of session:', parsed)
        if (!parsed || !parsed.destination) {
          console.error('Session write verification failed. Written:', written, 'Parsed:', parsed)
          throw new Error('Session write verification failed')
        }
        return true
      }, false)

      if (!storageSuccess) {
        console.error('Storage operation failed')
        throw new Error('Failed to save session data')
      }

      // Verify using session manager's methods
      const savedSession = getStoredSession()
      console.log('Final session verification:', savedSession)
      if (!savedSession) {
        console.error('Failed to save session')
        throw new Error('Failed to save session')
      }

      if (!savedSession.destination || !savedSession.startDate || !savedSession.endDate || 
          !savedSession.preferences || !savedSession.preferences.length || 
          !savedSession.sessionId || !savedSession.startTime || 
          !savedSession.lastActive || !savedSession.expiresAt) {
        console.error('Incomplete session:', savedSession)
        throw new Error('Session data incomplete')
      }

      // Use direct navigation with reload to ensure clean state
      window.location.href = `/chat?session=${session.sessionId}`
    } catch (error) {
      console.error('Error:', error)
      alert('An error occurred while processing your request. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const goToNextStep = () => {
    if (currentStep === 1) {
      // Save destination and clear input
      if (destinationRef.current) {
        destinationRef.current.value = ""
      }
    }
    setCurrentStep(prev => prev + 1)
  }

  const goToPrevStep = () => {
    if (currentStep === 2) {
      // Clear date range input when going back
      if (dateRangeRef.current) {
        dateRangeRef.current.value = ""
      }
    }
    setCurrentStep(prev => prev - 1)
  }

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="destination">Where are you planning to travel?</Label>
              <Input
                ref={destinationRef}
                id="destination"
                placeholder="Enter a city"
                onChange={(e) => setFormData((prev) => ({ ...prev, destination: e.target.value }))}
              />
            </div>
            <div className="flex space-x-4">
              <Button
                className="w-full"
                onClick={goToNextStep}
                disabled={!formData.destination}
              >
                Next
              </Button>
            </div>
          </div>
        )
      case 2:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="date-range">When are you planning to travel?</Label>
              <Input
                ref={dateRangeRef}
                id="date-range"
                placeholder="Select date range"
                readOnly
              />
            </div>
            <div className="flex space-x-4">
              <Button variant="outline" className="w-full" onClick={goToPrevStep}>
                Back
              </Button>
              <Button
                className="w-full"
                onClick={goToNextStep}
                disabled={!formData.startDate || !formData.endDate}
              >
                Next
              </Button>
            </div>
          </div>
        )
      case 3:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>What are your travel preferences?</Label>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { value: "Culture and Heritage", label: "Culture", icon: Languages },
                  { value: "Nature", label: "Nature", icon: Trees },
                  { value: "Foodie", label: "Foodie", icon: Soup },
                  { value: "Leisure", label: "Leisure", icon: ShoppingBag },
                  { value: "Adventure", label: "Adventure", icon: Ship },
                  { value: "Arts & Museum", label: "Arts", icon: Palette }
                ].map(({ value, label, icon: Icon }) => (
                  <Button
                    key={value}
                    variant={formData.preferences.includes(value as TravelPreference) ? "default" : "outline"}
                    className="flex items-center justify-start space-x-2"
                    onClick={() => handlePreferenceToggle(value as TravelPreference)}
                  >
                    <span>{label}</span>
                    <Icon className="h-4 w-4" />
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex space-x-4">
              <Button variant="outline" className="w-full" onClick={goToPrevStep}>
                Back
              </Button>
              <Button
                className="w-full"
                onClick={goToNextStep}
                disabled={formData.preferences.length === 0}
              >
                Next
              </Button>
            </div>
          </div>
        )
      case 4:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>What's your budget range?</Label>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { value: "$", label: "Budget  $" },
                  { value: "$$", label: "Moderate  $$" },
                  { value: "$$$", label: "Luxury  $$$" },
                  { value: "$$$$", label: "Ultra Luxury  $$$$" }
                ].map(({ value, label }) => (
                  <Button
                    key={value}
                    variant={formData.budget === value ? "default" : "outline"}
                    className="flex items-center justify-start space-x-2"
                    onClick={() => setFormData((prev) => ({ ...prev, budget: value }))}
                  >
                    <span>{label}</span>
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex space-x-4">
              <Button variant="outline" className="w-full" onClick={goToPrevStep}>
                Back
              </Button>
              <Button
                className="w-full"
                onClick={handleSubmit}
                disabled={loading || !formData.budget}
              >
                {loading ? <LoadingSpinner /> : "Start Planning"}
              </Button>
            </div>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <>
      <main className="flex min-h-screen">
        <div className="w-64 bg-light-blue shadow-md space-y-14 p-6 border-r">
          <Link href="/" className="flex gap-x-1">
            <Image
              src="/images/travel-rizz.png"
              alt="Travel-Rizz Logo"
              width={40}
              height={40}
              className="h-12 w-12 object-contain"
            />
            <span className="font-caveat text-3xl h-min my-auto text-primary">Travel-Rizz</span>
          </Link>
          <Steps currentStep={currentStep} steps={steps} />
        </div>
        <div className="flex flex-1 p-6">
          <div className="max-w-md w-full m-auto space-y-8">
              {renderStepContent()}
          </div>
        </div>
      </main>
    </>
  )
}