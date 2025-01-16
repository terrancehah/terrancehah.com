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
    title: "Getting Started with Premium",
    src: "https://placehold.co/600x400/png?text=Premium+Features+Tutorial",
    description: "Learn how to use advanced features like personalized recommendations and detailed scheduling."
  },
  {
    id: 2,
    title: "Exploring Local Insights",
    src: "https://placehold.co/600x400/png?text=Local+Insights+Tutorial",
    description: "Discover hidden gems and local recommendations for your destination."
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
      <div className="bg-white rounded-lg shadow-lg p-6 max-w-3xl w-full mx-4">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100"
        >
          <X className="h-5 w-5" />
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
