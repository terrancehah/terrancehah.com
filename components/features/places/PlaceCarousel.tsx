import React, { useState, useEffect } from 'react';
import { Place } from '@/utils/places-utils';
import { PlaceCard } from './PlaceCard';

export const Carousel = ({ places }: { places: Place[] }) => {
    const [currentIndex, setCurrentIndex] = useState(0);

    const prevSlide = () => {
        setCurrentIndex((currentIndex + places.length - 1) % places.length);
    };

    const nextSlide = () => {
        setCurrentIndex((currentIndex + 1) % places.length);
    };

    // Add all places to map when carousel is shown
    useEffect(() => {
        places.forEach(place => {
            if (place?.location && window.addPlaceToMap) {
                window.addPlaceToMap({
                    latitude: place.location.latitude,
                    longitude: place.location.longitude,
                    title: typeof place.displayName === 'string' ? place.displayName : place.displayName.text,
                    place // Pass the full place object for click handling
                });
            }
        });
    }, [places]);

    return (
        <div className="carousel-wrapper p-0 w-full max-h-min flex justify-center">

            <div className="relative w-full p-0 max-h-min flex justify-center max-w-2xl mx-auto">

                <button className="absolute left-4 top-1/2 transform -translate-y-1/2 z-10 bg-white text-black border border-opacity-40 border-slate-400 p-2 rounded-full hover:bg-gray-200 focus:outline-none" onClick={prevSlide}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>

                <button className="absolute right-4 top-1/2 transform -translate-y-1/2 z-10 bg-white text-black border border-opacity-40 border-slate-400 p-2 rounded-full hover:bg-gray-200 focus:outline-none" onClick={nextSlide}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                </button>

                <div className="carousel-container w-[100%] overflow-hidden">
                    <div className="carousel flex transition-transform duration-500 ease-in-out" 
                        style={{ 
                            transform: `translateX(-${currentIndex * 100}%)`,
                            height: 'min-content'
                        }}>
                        {places.map((place: Place, index: number) => (
                            <div key={place.id || index} className="flex-none max-h-min w-full mb-2 flex justify-center">
                                <PlaceCard place={place} />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

