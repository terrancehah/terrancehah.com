"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { Label } from "../../components/ui/label"
import { Steps } from "../../components/ui/steps"
import { useRouter } from "next/navigation"
import { Check, MapPin, Calendar, Heart, Wallet, Trees, Utensils, ShoppingBag, Ship, Brush, Languages } from "lucide-react"
import flatpickr from "flatpickr"
import "flatpickr/dist/flatpickr.css"
import Script from "next/script"
import Image from "next/image"
import { TravelPreference, TravelSession } from '../../managers/types'
import { initializeSession, generateSessionId } from '../../utils/session-manager'
import LoadingSpinner from '../../components/LoadingSpinner'

// Add Google Maps types
declare global {
  interface Window {
    google: typeof google;
  }
}

export default function TravelFormPage() {
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const destinationRef = useRef<HTMLInputElement>(null)
  const dateRangeRef = useRef<HTMLInputElement>(null)
  const hiddenEndDateRef = useRef<HTMLInputElement>(null)

  const [formData, setFormData] = useState({
    destination: "",
    startDate: "",
    endDate: "",
    preferences: [] as TravelPreference[],
    budget: "",
    language: "en" as const, // Default to English
  })

  const steps = [
    {
      number: 1,
      title: "Destination",
      icon: MapPin,
    },
    {
      number: 2,
      title: "Travel Dates",
      icon: Calendar,
    },
    {
      number: 3,
      title: "Interests",
      icon: Heart,
    },
    {
      number: 4,
      title: "Budget",
      icon: Wallet,
    },
  ]

  useEffect(() => {
    // Initialize flatpickr
    if (dateRangeRef.current) {
      flatpickr(dateRangeRef.current, {
        mode: 'range',
        dateFormat: 'Y-m-d',
        minDate: 'today',
        onChange: function(selectedDates) {
          if (selectedDates.length === 2) {
            const startDate = selectedDates[0].toISOString().split('T')[0]
            const endDate = selectedDates[1].toISOString().split('T')[0]
            
            setFormData(prev => ({
              ...prev,
              startDate,
              endDate
            }))

            if (hiddenEndDateRef.current) {
              hiddenEndDateRef.current.value = endDate
            }
          }
        }
      })
    }

    // Initialize Google Places Autocomplete
    if (window.google && destinationRef.current) {
      const autocomplete = new google.maps.places.Autocomplete(destinationRef.current, {
        types: ['(cities)']
      })
      
      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace()
        if (destinationRef.current && place.formatted_address) {
          destinationRef.current.value = place.formatted_address
          setFormData(prev => ({
            ...prev,
            destination: place.formatted_address || "" // Ensure it's never undefined
          }))
        }
      })
    }
  }, [])

  const handlePreferenceToggle = (pref: TravelPreference) => {
    setFormData((prev) => {
      const updatedPreferences = prev.preferences.includes(pref)
        ? prev.preferences.filter((p) => p !== pref)
        : [...prev.preferences, pref]
      return { ...prev, preferences: updatedPreferences }
    })
  }

  const handleBudgetChange = (budget: string) => {
    setFormData((prev) => ({ ...prev, budget }))
  }

  const handleSubmit = async () => {
    setLoading(true)

    try {
      // Initialize session first
      const session = initializeSession()
      
      // Update session with form data
      session.destination = formData.destination
      session.startDate = formData.startDate
      session.endDate = formData.endDate
      session.preferences = formData.preferences
      session.budget = formData.budget
      session.language = formData.language
      
      // Redirect to chat page
      router.push(`/?session=${session.sessionId}`)
    } catch (error) {
      console.error('Error creating session:', error)
      setLoading(false)
    }
  }

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-2 max-w-lg w-full">
            <h2 className="text-xl font-raleway text-primary ml-5 mb-1">Where do you want to go?</h2>
            <Input
              ref={destinationRef}
              type="text"
              placeholder="Enter destination"
              name="destination"
              className="text-lg p-6"
            />
          </div>
        )
      case 2:
        return (
          <div className="space-y-2 max-w-lg w-full">
            <h2 className="text-xl font-raleway text-primary ml-5 mb-1">When are you traveling?</h2>
            <div className="space-y-4">
              <div>
                <Input
                  ref={dateRangeRef}
                  type="text"
                  placeholder="Select dates"
                  className="text-lg p-6"
                />
                <input 
                  type="hidden" 
                  ref={hiddenEndDateRef}
                />
              </div>
            </div>
          </div>
        )
      case 3:
        return (
          <div className="space-y-2 max-w-lg w-full">
            <h2 className="text-xl font-raleway text-primary ml-5 mb-1">What interests you?</h2>
            <div className="grid grid-cols-2 gap-4">
              {[
                { value: "nature", label: "Nature", icon: Trees },
                { value: "food", label: "Food", icon: Utensils },
                { value: "leisure", label: "Leisure", icon: ShoppingBag },
                { value: "adventure", label: "Adventure", icon: Ship },
                { value: "arts", label: "Arts", icon: Brush },
                { value: "culture", label: "Culture", icon: Languages },
              ].map((preference) => {
                const Icon = preference.icon
                const isSelected = formData.preferences.includes(preference.value as TravelPreference)
                return (
                  <Button
                    key={preference.value}
                    type="button"
                    variant={isSelected ? "default" : "outline"}
                    className={`flex items-center gap-x-2 ${
                      isSelected ? "bg-sky-blue hover:bg-sky-blue/90" : ""
                    }`}
                    onClick={() => handlePreferenceToggle(preference.value as TravelPreference)}
                  >
                    <Icon className="h-4 w-4" />
                    {preference.label}
                  </Button>
                )
              })}
            </div>
          </div>
        )
      case 4:
        return (
          <div className="space-y-2 max-w-lg w-full">
            <h2 className="text-xl font-raleway text-primary ml-5 mb-1">What's your budget?</h2>
            <select
              value={formData.budget}
              onChange={(e) => handleBudgetChange(e.target.value)}
              className="w-full h-12 outline-none relative cursor-pointer text-lg px-4 py-2 bg-white rounded-md text-gray-700 font-normal font-raleway border border-gray-200"
            >
              <option value="" disabled>Select Budget</option>
              <option value="$">Budget ($)</option>
              <option value="$$">Moderate ($$)</option>
              <option value="$$$">Luxury ($$$)</option>
              <option value="$$$$">Ultra Luxury ($$$$)</option>
            </select>
          </div>
        )
      default:
        return null
    }
  }

  const canProceed = () => {
    switch (currentStep) {
      case 1:
        return formData.destination !== ""
      case 2:
        return formData.startDate !== "" && formData.endDate !== ""
      case 3:
        return formData.preferences.length > 0
      case 4:
        return formData.budget !== ""
      default:
        return false
    }
  }

  return (
    <>
      <Script
        src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`}
        strategy="beforeInteractive"
      />
      
      <div className="min-h-screen bg-gradient">
        <div className="container mx-auto p-4">
          <div className="flex min-h-[calc(100vh-2rem)] gap-x-16">
            
            {/* Steps sidebar */}
            <div className="w-80 pt-8 hidden md:block bg-sky-50/50 rounded-lg p-8">
              <div className="flex items-center gap-x-3 mb-12">
                <Image
                  src="/images/travel-rizz.png"
                  alt="Travel-Rizz Logo"
                  width={40}
                  height={40}
                  className="h-10 w-10 object-contain"
                />
                <span className="font-caveat text-2xl text-primary">Travel-Rizz</span>
              </div>
              <Steps currentStep={currentStep} steps={steps} />
            </div>

            {/* Main content */}
            <div className="flex-1 flex items-center justify-center">
              <div className="w-full max-w-lg flex flex-col items-center">
                {renderStepContent()}
                <div className="mt-8 flex space-x-4">
                  {currentStep > 1 && (
                    <Button 
                      onClick={() => setCurrentStep(currentStep - 1)} 
                      variant="outline"
                      className="min-w-[100px]"
                    >
                      Back
                    </Button>
                  )}
                  {currentStep < 4 ? (
                    <Button 
                      onClick={() => setCurrentStep(currentStep + 1)}
                      disabled={!canProceed()}
                      className="min-w-[100px]"
                    >
                      Continue
                    </Button>
                  ) : (
                    <Button 
                      onClick={handleSubmit}
                      disabled={!canProceed() || loading}
                      className="min-w-[100px]"
                    >
                      {loading ? <LoadingSpinner /> : "Start Planning"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
