'use client';

import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import Autoplay from 'embla-carousel-autoplay';

interface PaymentSuccessPopupProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
}

// Video tutorials data - using placeholder images for now
const VIDEO_TUTORIALS = [
  {
    id: 1,
    title: "Visualised Route Planning",
    src: "https://placehold.co/600x400/png?text=Visualised+Route+Planning",
    description: "With the help of Google Advanced Routes API, we can visualize your trip's route in a clear and engaging way."
  },
  {
    id: 2,
    title: "Advanced Daily Itinerary Planning",
    src: "https://placehold.co/600x400/png?text=Daily+Itinerary+Planning",
    description: "Travel-Rizz helps you group activities and attractions to create daily itineraries."
  },
  {
    id: 3,
    title: "Travel Time between Attractions",
    src: "https://placehold.co/600x400/png?text=Travel+Time+between+Attractions",
    description: "Be informed about travel times between attractions for your trip, so you can plan your day ahead."
  },
  {
    id: 4,
    title: "Drag and Drop Attraction Organising",
    src: "https://placehold.co/600x400/png?text=Drag+and+Drop+Attraction",
    description: "Organise your trip by dragging and dropping attractions. It's just as simple as that."
  },
  {
    id: 5,
    title: "Add and Remove Attractions Easily",
    src: "https://placehold.co/600x400/png?text=Add+and+Remove+Attractions",
    description: "Add and remove attractions from your trip effortlessly, making it easy to plan your perfect day."
  }
];

// Configure autoplay plugin
const autoplayOptions = {
  delay: 4000,
  stopOnInteraction: false,
  stopOnMouseEnter: true,
  rootNode: (emblaRoot: HTMLElement) => emblaRoot
};

export default function PaymentSuccessPopup({ isOpen, onClose, title, description }: PaymentSuccessPopupProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel(
    { loop: true, dragFree: true }, 
    [Autoplay(autoplayOptions)]
  );
  const [currentSlide, setCurrentSlide] = useState(0);

  useEffect(() => {
    if (!emblaApi) return;

    emblaApi.on('select', () => {
      setCurrentSlide(emblaApi.selectedScrollSnap());
    });

    return () => {
      emblaApi.destroy();
    };
  }, [emblaApi]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg p-6 max-w-3xl w-full mx-4 relative">
        <button
          onClick={onClose}
          className="absolute -top-2 -right-2 p-2 rounded-full bg-white hover:bg-gray-100 hover:shadow-slate-400 shadow-md shadow-slate-500 transition-colors"
          aria-label="Close popup"
        >
          <X className="h-5 w-5 text-gray-600" />
        </button>
        
        <div className="space-y-6">
          <div className="text-center">
            <h3 className="text-2xl font-semibold mb-2">{title}</h3>
            {description && <p className="text-gray-600 mb-6">{description}</p>}
          </div>

          {/* Image Carousel */}
          <div className="overflow-hidden" ref={emblaRef}>
            <div className="flex">
              {VIDEO_TUTORIALS.map((tutorial, index) => (
                <div key={tutorial.id} className="flex-[0_0_100%] min-w-0">
                  <div className="p-2">
                    <img
                      className="w-full rounded-lg"
                      src={tutorial.src}
                      alt={tutorial.title}
                    />
                    <h4 className="text-lg font-semibold mt-4">{tutorial.title}</h4>
                    <p className="text-gray-600">{tutorial.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Dots indicator */}
          <div className="flex justify-center gap-2 mt-4">
            {VIDEO_TUTORIALS.map((_, index) => (
              <button
                key={index}
                className={`w-2 h-2 rounded-full ${
                  index === currentSlide ? 'bg-blue-500' : 'bg-gray-300'
                }`}
                onClick={() => emblaApi?.scrollTo(index)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
