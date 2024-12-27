import React, { useState } from 'react';
import { Place } from '@/utils/places-utils';
import { PlaceCard } from './PlaceCard';

interface SavedPlacesCarouselProps {
    places: Place[];
    onRemove: (placeId: string) => void;
}

export const SavedPlacesCarousel: React.FC<SavedPlacesCarouselProps> = ({ places, onRemove }) => {
    console.log('Debug - SavedPlacesCarousel rendering with places:', places);
    const [currentIndex, setCurrentIndex] = useState(0);

    const prevSlide = () => {
        setCurrentIndex((currentIndex + places.length - 1) % places.length);
    };

    const nextSlide = () => {
        setCurrentIndex((currentIndex + 1) % places.length);
    };

    if (!places || places.length === 0) {
        return (
            <div className="p-4 bg-white rounded-lg shadow-sm">
                <p className="text-gray-500">No places saved yet</p>
            </div>
        );
    }

    return (
        <div className="carousel-wrapper p-0 w-full max-h-min flex flex-col">
            {/* <div className="p-4 bg-white">
                <h3 className="text-lg font-semibold mb-3">Saved Places</h3>
            </div> */}

            <div className="relative w-full p-0 max-h-min flex justify-center max-w-2xl mx-auto">
                {places.length > 1 && (
                    <>
                        <button 
                            className="absolute left-5 top-1/2 transform -translate-y-1/2 z-10 bg-white text-black border border-opacity-40 border-slate-400 p-2 rounded-full hover:bg-gray-200 focus:outline-none" 
                            onClick={prevSlide}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>

                        <button 
                            className="absolute right-5 top-1/2 transform -translate-y-1/2 z-10 bg-white text-black border border-opacity-40 border-slate-400 p-2 rounded-full hover:bg-gray-200 focus:outline-none" 
                            onClick={nextSlide}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                            </svg>
                        </button>
                    </>
                )}

                <div className="carousel-container w-[100%] overflow-hidden">
                    <div 
                        className="carousel flex transition-transform duration-500 ease-in-out" 
                        style={{ 
                            transform: `translateX(-${currentIndex * 100}%)`,
                            height: 'min-content'
                        }}
                    >
                        {places.map((place: Place, index: number) => (
                            <div key={place.id || index} className="flex-none max-h-min w-full mb-2 flex justify-center">
                                <PlaceCard 
                                    place={place}
                                    showActions={true}
                                    onRemove={() => {
                                        if (place.id) {
                                            onRemove(place.id);
                                            // Move to previous slide if we're deleting the last item
                                            if (currentIndex === places.length - 1 && currentIndex > 0) {
                                                setCurrentIndex(currentIndex - 1);
                                            }
                                        }
                                    }}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Pagination dots */}
            {/* {places.length > 1 && (
                <div className="flex justify-center gap-2 mt-4">
                    {places.map((_, index) => (
                        <button
                            key={index}
                            className={`w-2 h-2 rounded-full transition-colors ${
                                index === currentIndex ? 'bg-blue-500' : 'bg-gray-300'
                            }`}
                            onClick={() => setCurrentIndex(index)}
                        />
                    ))}
                </div>
            )} */}
        </div>
    );
};

