///Users/terrancehah/Documents/terrancehah.com/ai/tools.ts

import { tool as createTool } from 'ai';
import { z } from 'zod';
import { 
    TravelPreference,
    BudgetLevel,
    SupportedLanguage
} from '../managers/types';
import { 
    fetchPlaces,
    searchPlaceByText,
    searchMultiplePlacesByText,
    Place
} from '../utils/places-utils';

// Standardized Tool Response interfaces
export interface ToolResponse<T = Record<string, unknown>> {
    type: string;
    status: 'success' | 'error' | 'empty';
    props: T;
    error?: string;
}

export interface BaseToolProps {
    error?: string;
    loading?: boolean;
}

// Tool for Budget Selection
export const budgetSelectorTool = createTool({
    description: 'Display budget level options for the trip. Use this when discussing trip costs or when the user wants to set their budget preference.',
    parameters: z.object({
        currentBudget: z.enum(['$', '$$', '$$$', '$$$$'] as const).optional()
    }),
    execute: async function ({ currentBudget }) {
        return {
            type: 'budgetSelector',
            props: {
                currentBudget
            }
        };
    }
});

// Tool for Travel Preferences
export const preferenceSelectorTool = createTool({
    description: 'Display options for selecting travel preferences and interests.',
    parameters: z.object({
        currentPreferences: z.array(z.nativeEnum(TravelPreference)).optional()
    }),
    execute: async function ({ currentPreferences }) {
        return {
            type: 'preferenceSelector',
            props: {
                currentPreferences
            }
        };
    }
});

// Tool for Date Selection
export const datePickerTool = createTool({
    description: 'Display a date picker for selecting travel dates.',
    parameters: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional()
    }),
    execute: async function ({ startDate, endDate }) {
        return {
            type: 'datePicker',
            props: {
                dates: {
                    startDate,
                    endDate
                }
            }
        };
    }
});

// Tool for Language Selection
export const languageSelectorTool = createTool({
    description: 'Display language selection options.',
    parameters: z.object({
        currentLanguage: z.string().optional()
    }),
    execute: async function ({ currentLanguage }) {
        return {
            type: 'languageSelector',
            props: {
                currentLanguage: currentLanguage as SupportedLanguage
            }
        };
    }
});

// Tool for Transport Selection
export const transportSelectorTool = createTool({
    description: 'Display transport method selection options. Use this when discussing transportation options for the trip, such as flights, trains, or car rentals.',
    parameters: z.object({
        selectedMethod: z.string().optional()
    }),
    execute: async function ({ selectedMethod }) {
        return {
            type: 'transportSelector',
            props: { selectedMethod }
        };
    }
});

// Tool for Place Display
export const placeCardTool = createTool({
    description: 'Display information about one specific place. Use this whenever the user explicitly asks for ONE place, whether by name or type (e.g., "show me one theatre", "show me one restaurant", "show me The Little Mermaid statue").',
    parameters: z.object({
        searchText: z.string().describe('The name or description of the place to search for'),
        location: z.object({
            latitude: z.number(),
            longitude: z.number()
        })
    }),
    execute: async function ({ searchText, location }) {
        try {
            const place = await searchPlaceByText(searchText, location);
            
            if (!place) {
                console.error('No place found for search text:', searchText);
                return {
                    type: 'placeCard',
                    props: { place: null, showActions: false }
                };
            }

            return {
                type: 'placeCard',
                props: { 
                    place,
                    showActions: false 
                }
            };
        } catch (error) {
            console.error('Error searching for place:', error);
            return {
                type: 'placeCard',
                props: { place: null, showActions: false }
            };
        }
    }
});

// Tool for Place Carousel
export const carouselTool = createTool({
    description: 'Display multiple places in a carousel. Use this when the user wants to search for multiple places (e.g., "show me cafes", "show me museums near me", "find restaurants").',
    parameters: z.object({
        searchText: z.string().describe('The search query for places (e.g., "cafes", "museums", "restaurants")'),
        location: z.object({
            latitude: z.number(),
            longitude: z.number()
        }),
        maxResults: z.number().optional().default(5)
    }),
    execute: async function ({ searchText, location, maxResults }) {
        try {
            const places = await searchMultiplePlacesByText(
                searchText,
                location,
                maxResults
            );

            if (!places || places.length === 0) {
                console.error('No places found for search:', { searchText });
                return {
                    type: 'carousel',
                    props: { places: [] }
                };
            }

            return {
                type: 'carousel',
                props: { places }
            };
        } catch (error) {
            console.error('Error searching places for carousel:', error);
            return {
                type: 'carousel',
                props: { places: [] }
            };
        }
    }
});

// Tool for Details Card
export const detailsCardTool = createTool({
    description: 'Display travel details summary. Use this when the user wants to view a summary of their trip details, including destination, dates, preferences, budget, and more.',
    parameters: z.object({
        content: z.object({
            destination: z.string(),
            dates: z.object({
                startDate: z.string(),
                endDate: z.string()
            }).optional(),
            preferences: z.array(z.string()).optional(),
            budget: z.string().optional(),
            language: z.string().optional(),
            transport: z.array(z.string()).optional(),
            dining: z.array(z.string()).optional()
        })
    }),
    execute: async function ({ content }) {
        return {
            type: 'detailsCard',
            props: { content }
        };
    }
});

export const weatherChartTool = createTool({
    description: 'Display historical weather data including temperature and precipitation for a location.',
    parameters: z.object({
        lat: z.number().min(-90).max(90).describe('Latitude of the location'),
        lon: z.number().min(-180).max(180).describe('Longitude of the location'),
        city: z.string().describe('City name for display'),
        startDate: z.string().describe('Trip start date in DD/MM/YYYY format'),
        endDate: z.string().describe('Trip end date in DD/MM/YYYY format'),  // Added this param
        units: z.enum(['us', 'uk', 'metric'] as const).optional().default('metric')
    }),
    execute: async function ({ lat, lon, city, startDate, endDate, units = 'metric' }) {
        // Parse DD/MM/YYYY dates
        const [startDay, startMonth, startYear] = startDate.split('/').map(Number);
        const [endDay, endMonth, endYear] = endDate.split('/').map(Number);
        
        // Format dates for API (YYYY-MM-DD)
        const formattedStartDate = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
        const formattedEndDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

        // Calculate number of days in the range
        const start = new Date(formattedStartDate);
        const end = new Date(formattedEndDate);
        const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        
        // Calculate how many extra days we need for 30 days total
        const extraDays = Math.max(0, 30 - daysDiff);
        const daysToAddBefore = Math.floor(extraDays / 2);
        const daysToAddAfter = extraDays - daysToAddBefore;

        // Extend dates to get 30 days
        start.setDate(start.getDate() - daysToAddBefore);
        end.setDate(end.getDate() + daysToAddAfter);

        // Format extended dates for API
        const extendedStartDate = start.toISOString().split('T')[0];
        const extendedEndDate = end.toISOString().split('T')[0];

        console.log('[weatherChartTool] Date conversion:', {
            originalDate: startDate,
            originalEndDate: endDate,
            formattedStartDate: extendedStartDate,
            formattedEndDate: extendedEndDate,
            totalDays: 30,
            originalRange: daysDiff,
            addedBefore: daysToAddBefore,
            addedAfter: daysToAddAfter
        });

        return {
            type: 'weatherChart',
            props: {
                lat,
                lon,
                city,
                startDate: extendedStartDate,
                endDate: extendedEndDate,
                units,
            }
        };
    }
});

// Export all tools with their names
export const tools = {
    budgetSelector: budgetSelectorTool,
    preferenceSelector: preferenceSelectorTool,
    datePicker: datePickerTool,
    languageSelector: languageSelectorTool,
    transportSelector: transportSelectorTool,
    placeCard: placeCardTool,
    carousel: carouselTool,
    detailsCard: detailsCardTool,
    weatherChart: weatherChartTool
};
