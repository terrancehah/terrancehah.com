import React from 'react'
import { MapPin, Star, Calendar, Coffee, Headphones, Zap } from 'lucide-react'

const features = [
  {
    icon: <MapPin className="w-6 h-6 md:w-8 md:h-8" />,
    title: "Unlimited Places Browsing",
    description: "Explore an endless array of destinations tailored just for you.",
  },
  {
    icon: <Star className="w-6 h-6 md:w-8 md:h-8" />,
    title: "Personalized Recommendations",
    description: "Get AI-powered suggestions at your fingertips.",
  },
  {
    icon: <Calendar className="w-6 h-6 md:w-8 md:h-8" />,
    title: "Advanced Itinerary Planning",
    description: "Create day-by-day itineraries that match your preferences.",
  },
  {
    icon: <Coffee className="w-6 h-6 md:w-8 md:h-8" />,
    title: "Local Custom Tips",
    description: "Discover local tips and advice to make your trip even more enjoyable.",
  },
  {
    icon: <Headphones className="w-6 h-6 md:w-8 md:h-8" />,
    title: "Priority Support",
    description: "Get fast, personalized assistance whenever you need it.",
  },
  {
    icon: <Zap className="w-6 h-6 md:w-8 md:h-8" />,
    title: "Ad-Free Experience",
    description: "Enjoy a clean, distraction-free planning experience without any advertisements.",
  }
]

export default function FeatureCarousel() {
  return (
    <div className="w-full overflow-hidden relative">
      <style jsx>{`
        @keyframes scroll {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
        .scroll-container {
          display: flex;
          animation: scroll 30s linear infinite;
          width: fit-content;
        }
        /* Double the content for seamless loop */
        .scroll-content {
          display: flex;
          gap: 1rem;
          padding: 0.5rem;
        }
      `}</style>

      <div className="scroll-container">
        
        {/* auto-scroll features carousel */}
        <div className="scroll-content z-80">
          {features.map((feature, index) => (
            <div
              key={index}
              className="w-[300px] flex-shrink-0 pb-1"
            >
              <div className="bg-white rounded-2xl h-[160px] md:h-[220px] flex align-middle p-5 mx-2 my-1 border border-gray-100 shadow-md transform transition-all hover:shadow-lg z-70">
                <div className="flex flex-col items-center text-center space-y-3">
                  <div className="text-sky-blue bg-sky-50 p-3 rounded-full">
                    {feature.icon}
                  </div>
                  <h3 className="text-base lg:text-xl font-bold text-primary">{feature.title}</h3>
                  <p className="text-gray-600 text-xs lg:text-sm">{feature.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Duplicate content for seamless loop */}
        <div className="scroll-content">
          {features.map((feature, index) => (
            <div
              key={`duplicate-${index}`}
              className="w-[320px] md:w-[300px] flex-shrink-0"
            >
              <div className="bg-white rounded-2xl h-[160px] md:h-[220px] flex align-middle p-3 md:p-5 mx-2 my-1 border border-gray-100 shadow-md transform transition-all  hover:shadow-lg">
              <div className="flex flex-col items-center text-center space-y-3">
                  <div className="text-sky-blue bg-sky-50 p-3 rounded-full">
                    {feature.icon}
                  </div>
                  <h3 className="text-base lg:text-xl font-bold text-primary">{feature.title}</h3>
                  <p className="text-gray-600 text-xs lg:text-sm">{feature.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
