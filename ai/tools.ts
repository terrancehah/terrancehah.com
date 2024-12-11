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

// Tool for Weather Chart
export const weatherChartTool = createTool({
    description: 'Display historical weather data including temperature and precipitation for a location. Since we cannot provide future weather data, we will show historical data from the same month last year. For example, if a user asks about December 2024, we will show data from December 2023. Use this when discussing weather patterns or climate for a destination.',
    parameters: z.object({
        lat: z.number().min(-90).max(90).describe('Latitude of the location'),
        lon: z.number().min(-180).max(180).describe('Longitude of the location'),
        targetMonth: z.number().min(1).max(12).describe('Target month (1-12)'),
        units: z.enum(['standard', 'metric', 'imperial'] as const).optional().default('metric')
    }),
    execute: async function ({ lat, lon, targetMonth, units = 'metric' }) {
        // Calculate date range for the same month last year
        const now = new Date('2024-12-11T03:04:40+08:00'); // Use provided time
        const lastYear = now.getFullYear() - 1;
        const startDate = new Date(lastYear, targetMonth - 1, 1);
        const endDate = new Date(lastYear, targetMonth, 0); // Last day of the month

        console.log('[weatherChartTool] Fetching weather data:', {
            lat,
            lon,
            targetMonth,
            units,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
        });

        // Format dates in YYYY-MM-DD format as required by the API
        const formattedStartDate = startDate.toISOString().split('T')[0];
        const formattedEndDate = endDate.toISOString().split('T')[0];

        // Fetch weather data
        const baseUrl = typeof window === 'undefined' ? process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000' : window.location.origin;
        const url = `${baseUrl}/api/weather/historical?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&startDate=${formattedStartDate}&endDate=${formattedEndDate}&units=${units}`;
        console.log('[weatherChartTool] API URL:', url);

        try {
            const response = await fetch(url);
            console.log('[weatherChartTool] API response status:', response.status);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[weatherChartTool] API error:', errorText);
                throw new Error(`Failed to fetch weather data: ${response.statusText}`);
            }

            const weatherData = await response.json();
            console.log('[weatherChartTool] Weather data:', weatherData);

            return {
                type: 'weatherChart',
                props: {
                    lat,
                    lon,
                    units,
                    initialData: weatherData
                }
            };
        } catch (error) {
            console.error('[weatherChartTool] Error:', error);
            throw error;
        }
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
