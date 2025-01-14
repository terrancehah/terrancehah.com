import { tool as createTool, ToolExecutionOptions } from 'ai';
import { z } from 'zod';
import { 
    TravelPreference,
    BudgetLevel,
    SupportedLanguage,
    ComponentType,
    TravelDetails
} from '../managers/types';
import { 
    fetchPlaces,
    searchPlaceByText,
    searchMultiplePlacesByText,
    Place
} from '../utils/places-utils';
import { validateStageProgression } from '../managers/stage-manager';
import { getCurrencyFromCountry } from '../utils/currency-utils';

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
                currentBudget: currentBudget as BudgetLevel
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
                currentPreferences: currentPreferences as TravelPreference[]
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
                startDate,
                endDate
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
    description: 'Display information about one specific place. Use this whenever the user explicitly asks for ONE place, whether by name or type (e.g., \"show me one theatre\", \"show me one restaurant\", \"show me The Little Mermaid statue\").',
    parameters: z.object({
        searchText: z.string().describe('The name or description of the place to search for'),
        location: z.object({
            latitude: z.number(),
            longitude: z.number()
        }),
        destination: z.string().describe('Name of the destination city')
    }),
    execute: async function ({ searchText, location, destination }) {
        try {
            const place = await searchPlaceByText(searchText, location, destination);
            
            if (!place) {
                console.error('No place found for search text:', searchText);
                return {
                    type: 'placeCard',
                    props: { place: null },
                    error: 'Could not find a unique place. Try searching for something else.'
                };
            }

            return {
                type: 'placeCard',
                props: { 
                    place
                }
            };
        } catch (error) {
            console.error('Error searching for place:', error);
            return {
                type: 'placeCard',
                props: { place: null }
            };
        }
    }
});

// Tool for Place Carousel
export const carouselTool = createTool({
    description: 'Display multiple places in a carousel based on preferences or specific place types and automatically save them into savedPlaces.',
    parameters: z.object({
        preferences: z.array(z.nativeEnum(TravelPreference)).optional(), // Changed to array
        placeType: z.string().optional().describe('Specific place type to search for'),
        location: z.object({
            latitude: z.number(),
            longitude: z.number()
        }),
        maxResults: z.number().optional().default(5)
    }),
    execute: async function ({ preferences, placeType, location, maxResults }) {
        try {
            let places: Place[] = [];
            
            if (preferences && preferences.length > 0) {
                // Use our existing function to get places by preference
                places = await fetchPlaces(
                    location.latitude,
                    location.longitude,
                    preferences,
                    maxResults
                );
            } else if (placeType) {
                // Search by specific place type
                places = await fetchPlaces(
                    location.latitude,
                    location.longitude,
                    undefined,
                    maxResults,
                    [placeType]
                );
            }

            return {
                type: 'carousel',
                props: { places }
            };
        } catch (error) {
            console.error('Error in carousel tool:', error);
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
        endDate: z.string().describe('Trip end date in DD/MM/YYYY format'),
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

export const savedPlacesListTool = createTool({
    description: 'Display all currently saved places in a list view. When user asks to see saved places (e.g. "show me my saved places", "what places have I saved", etc), pass ALL places from the savedPlaces parameter to this tool.',
    parameters: z.object({
        savedPlaces: z.array(z.object({
            id: z.string(),
            displayName: z.union([
                z.object({
                    text: z.string(),
                    languageCode: z.string()
                }),
                z.string()
            ]).optional(), // Make optional
            primaryType: z.string().optional(), // Make optional
            location: z.object({
                latitude: z.number(),
                longitude: z.number()
            }).optional(), // Make optional
            formattedAddress: z.string().optional(), // Make optional
            photos: z.array(z.object({
                name: z.string(),
                widthPx: z.number().optional(),
                heightPx: z.number().optional(),
                authorAttributions: z.array(z.object({
                    displayName: z.string().optional(),
                    uri: z.string().optional(),
                    photoUri: z.string().optional()
                })).optional() // Make optional
            })).optional().default([]), // Make optional with default
            primaryTypeDisplayName: z.object({
                text: z.string(),
                languageCode: z.string()
            }).optional() // Already optional
        }))
    }),
    execute: async function ({ savedPlaces }) {
        console.log('[savedPlacesListTool] Executing with places:', savedPlaces?.map(p => ({
            id: p.id,
            hasPhotos: Boolean(p.photos?.length),
            photoCount: p.photos?.length,
            firstPhoto: p.photos?.[0],
            primaryTypeDisplayName: p.primaryTypeDisplayName
        })));
        
        // Ensure we're passing the full array of places
        if (!Array.isArray(savedPlaces)) {
            console.error('[savedPlacesListTool] savedPlaces is not an array:', savedPlaces);
            return {
                type: 'savedPlacesList',
                props: { places: [] }
            };
        }

        // Make sure we pass the complete place objects
        return {
            type: 'savedPlacesList',
            props: { 
                places: savedPlaces.map(place => ({
                    ...place,
                    photos: place.photos || [],
                    primaryTypeDisplayName: place.primaryTypeDisplayName || { text: '', languageCode: 'en' }
                })),
                onRemove: undefined // Make it explicit that we're not handling removal here
            }
        };
    }
});

// Simplify the stage progress tool to only include nextStage
export const stageProgressTool = createTool({
    description: 'Update the current planning stage only when certain criteria are met.',
    parameters: z.object({
        nextStage: z.number().min(1).max(5),
        currentStage: z.number().min(1).max(5),
        travelDetails: z.object({
            destination: z.string(),
            location: z.object({
                latitude: z.number(),
                longitude: z.number()
            }),
            startDate: z.string(),
            endDate: z.string(),
            preferences: z.array(z.string()),
            budget: z.string(),
            language: z.string(),
            transport: z.array(z.string())
        }),
        metrics: z.object({
            totalPrompts: z.number(),
            savedPlacesCount: z.number(),
            isPaid: z.boolean(),
            paymentReference: z.string()
        })
    }),
    execute: async function({ nextStage, currentStage, travelDetails, metrics }) {
        // console.log('[StageProgressTool] Executing:', { nextStage, currentStage, metrics });
        
        const validationResult = validateStageProgression(
            currentStage,
            nextStage,
            travelDetails as TravelDetails // Type assertion since we validate fields in validateStageProgression
        );

        if (!validationResult.canProgress) {
            console.log('[StageProgressTool] Validation failed:', validationResult.missingRequirements);
            return {
                type: 'stageProgress',
                status: 'error',
                props: { 
                    nextStage: currentStage,
                    error: `Cannot progress to stage ${nextStage}. Missing requirements: ${validationResult.missingRequirements.join(', ')}`
                }
            };
        }

        return {
            type: 'stageProgress',
            status: 'success',
            props: { nextStage }
        };
    }
});

// Tool for Quick Response
export const quickResponseTool = createTool({
    description: `Present users with exactly 3 contextually relevant quick response options.
    
    CRITICAL RULES:
    1. YOU MUST ALWAYS RETURN EXACTLY 3 OPTIONS - NO EXCEPTIONS
    2. Keep options concise and action-oriented
    3. Options must make sense as natural chat responses
    4. Each option should be 2-6 words
    
    Stage-specific guidelines:
    Stage 1: Focus on parameter updates (e.g., \"Update my travel dates\", \"Change my budget\")
    Stage 2: Focus on city info (e.g., \"Check the weather\", \"See currency rates\")
    Stage 3: Focus on places (e.g., \"Show me museums\", \"Find restaurants\")
    Stage 4: Focus on itinerary (e.g., \"Add more activities\", \"Review the plan\")
    Stage 5: Focus on completion (e.g., \"Download itinerary\", \"Share with friends\")`,
    parameters: z.object({
        responses: z.array(z.string()).length(3).describe('Exactly 3 quick response options')
    }),
    execute: async function ({ responses }) {
        // console.log('[QuickResponse Tool] Executing with responses:', responses);

        if (!Array.isArray(responses) || responses.length !== 3) {
            console.error('[QuickResponse Tool] Invalid responses:', responses);
            throw new Error('Must provide exactly 3 responses');
        }

        // Validate each response
        responses.forEach((response, index) => {
            if (!response || typeof response !== 'string' || response.trim().length === 0) {
                throw new Error(`Invalid response at index ${index}`);
            }
        });

        console.log('[QuickResponse Tool] Returning valid responses');
        
        return {
            type: 'quickResponse',
            props: { responses }
        };
    }
});

// Tool for Currency Conversion
export const currencyConverterTool = createTool({
    description: 'Display currency conversion rates for the destination country. Use this when discussing costs, budgets, or when the user wants to understand currency exchange rates.',
    parameters: z.object({
        amount: z.number().optional().describe('Amount to convert in the destination currency'),
        destination: z.string().describe('Destination country or city')
    }),
    execute: async function ({ amount = 100, destination }) {
        if (!destination) {
            throw new Error('Destination is required for currency conversion');
        }

        const baseCurrency = getCurrencyFromCountry(destination);
        
        return {
            type: 'currencyConverter',
            props: {
                baseCurrency,
                baseAmount: amount,
                defaultCurrencies: ['USD', 'EUR', 'GBP', 'CNY', 'JPY']
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
    weatherChart: weatherChartTool,
    savedPlacesList: savedPlacesListTool,
    stageProgress: stageProgressTool,
    quickResponse: quickResponseTool,
    currencyConverter: currencyConverterTool
};