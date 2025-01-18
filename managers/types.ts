///Users/terrancehah/Documents/terrancehah.com/managers/types.ts

import { Message as AiMessage, JSONValue } from 'ai';
import { Place } from '../utils/places-utils';
import { ReactNode } from 'react';

export interface TravelDetails {
    destination: string;
    location?: {
        latitude: number;
        longitude: number;
    };
    startDate: string;
    endDate: string;
    preferences: string[];
    budget: string;
    language: string;
    transport: string[];
}

export enum ComponentType {
    DatePicker = 'DatePicker',
    PreferenceSelector = 'PreferenceSelector',
    BudgetSelector = 'BudgetSelector',
    LanguageSelector = 'LanguageSelector',
    PlaceCard = 'PlaceCard',
    TransportSelector = 'TransportSelector',
    Carousel = 'Carousel',
    DetailsCard = 'DetailsCard',
    SavedPlacesCarousel = 'SavedPlacesCarousel',
    QuickResponse = 'QuickResponse'
}

export enum BudgetLevel {
    Budget = '$',
    Moderate = '$$',
    Luxury = '$$$',
    UltraLuxury = '$$$$'
}

export enum TravelPreference {
    Culture = 'Culture and Heritage',
    Nature = 'Nature',
    Food = 'Foodie',
    Relaxation = 'Leisure',
    Adventure = 'Adventure',
    Shopping = 'Arts & Museum'
}

export enum SupportedLanguage {
    English = 'English',
    Malay = 'Malay (Bahasa Melayu)',
    Spanish = 'Espanol',
    French = 'Francais',
    German = 'Deutsch',
    Italian = 'Italiano',
    Czech = 'Czech (Cestina)',
    SimplifiedChinese = 'Simplified Chinese (简体中文)',
    TraditionalChinese = 'Traditional Chinese (繁體中文)',
    Japanese = 'Japanese (日本語)',
    Korean = 'Korean (한국어)'
}

export const BUDGET_DESCRIPTIONS: Record<BudgetLevel, string> = {
    [BudgetLevel.Budget]: 'Budget-friendly options ($)',
    [BudgetLevel.Moderate]: 'Mid-range options ($$)',
    [BudgetLevel.Luxury]: 'High-end options ($$$)',
    [BudgetLevel.UltraLuxury]: 'Ultra luxury options ($$$$)'
};

export const PREFERENCE_ICONS: Record<TravelPreference, string> = {
    [TravelPreference.Culture]: '🎏',
    [TravelPreference.Nature]: '🍀',
    [TravelPreference.Food]: '🍱',
    [TravelPreference.Relaxation]: '🌇',
    [TravelPreference.Adventure]: '🪂',
    [TravelPreference.Shopping]: '🎨'
};

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
    [SupportedLanguage.English]: 'English',
    [SupportedLanguage.Malay]: 'Malay (Bahasa Melayu)',
    [SupportedLanguage.Spanish]: 'Espanol',
    [SupportedLanguage.French]: 'Francais',
    [SupportedLanguage.German]: 'Deutsch',
    [SupportedLanguage.Italian]: 'Italiano',
    [SupportedLanguage.Czech]: 'Czech (Cestina)',
    [SupportedLanguage.SimplifiedChinese]: 'Simplified Chinese (简体中文)',
    [SupportedLanguage.TraditionalChinese]: 'Traditional Chinese (繁體中文)',
    [SupportedLanguage.Japanese]: 'Japanese (日本語)',
    [SupportedLanguage.Korean]: 'Korean (한국어)'
};

export const BUDGET_OPTIONS = [
    { value: BudgetLevel.Budget, label: 'Budget', description: 'Budget-friendly options with basic amenities' },
    { value: BudgetLevel.Moderate, label: 'Moderate', description: 'Mid-range options with good value' },
    { value: BudgetLevel.Luxury, label: 'Luxury', description: 'High-end options with premium services' },
    { value: BudgetLevel.UltraLuxury, label: 'Ultra Luxury', description: 'Exclusive luxury experiences' }
];

export const LANGUAGE_OPTIONS = Object.entries(SupportedLanguage).map(([key, value]) => ({
    value,
    label: LANGUAGE_LABELS[value as SupportedLanguage]
}));

export const PREFERENCE_OPTIONS = [
    { value: TravelPreference.Culture, label: 'Culture and Heritage', icon: PREFERENCE_ICONS[TravelPreference.Culture] },
    { value: TravelPreference.Nature, label: 'Nature', icon: PREFERENCE_ICONS[TravelPreference.Nature] },
    { value: TravelPreference.Food, label: 'Foodie', icon: PREFERENCE_ICONS[TravelPreference.Food] },
    { value: TravelPreference.Relaxation, label: 'Leisure', icon: PREFERENCE_ICONS[TravelPreference.Relaxation] },
    { value: TravelPreference.Adventure, label: 'Adventure', icon: PREFERENCE_ICONS[TravelPreference.Adventure] },
    { value: TravelPreference.Shopping, label: 'Arts & Museum', icon: PREFERENCE_ICONS[TravelPreference.Shopping] }
];

export interface ComponentProps {
    [ComponentType.DatePicker]: {
        startDate?: string;
        endDate?: string;
        onDateChange: (startDate: string, endDate: string) => void;
    };
    [ComponentType.PreferenceSelector]: {
        selectedPreferences: TravelPreference[];
        onPreferenceChange: (preferences: TravelPreference[]) => void;
    };
    [ComponentType.BudgetSelector]: {
        selectedBudget?: BudgetLevel;
        onBudgetChange: (budget: BudgetLevel) => void;
    };
    [ComponentType.LanguageSelector]: {
        selectedLanguage?: SupportedLanguage;
        onLanguageChange: (language: SupportedLanguage) => void;
    };
    [ComponentType.PlaceCard]: {
        title: string;
        description: string;
        imageUrl: string;
        onClick?: () => void;
    };
    [ComponentType.TransportSelector]: {
        options: string[];
        onSelect: (option: string) => void;
    };
    [ComponentType.Carousel]: {
        items: Array<{
            title: string;
            description: string;
            imageUrl: string;
        }>;
    };
    [ComponentType.DetailsCard]: {
        title: string;
        content: ReactNode;
    };
    [ComponentType.SavedPlacesCarousel]: {
        places: Place[];
        onDelete: (placeId: string) => void;
    };
    [ComponentType.QuickResponse]: {
        responses: string[];
        onResponseSelect: (text: string) => void;
    };
}

export interface ComponentRegistration<T extends ComponentType> {
    component: React.ComponentType<ComponentProps[T]>;
    defaultProps?: Partial<ComponentProps[T]>;
}

export interface ComponentState {
    id: string;
    type: ComponentType;
    props: any;
    isVisible: boolean;
    order: number;
}

export interface ComponentTransition {
    id: string;
    from: Partial<ComponentState>;
    to: Partial<ComponentState>;
    duration?: number;
}

export interface ComponentUpdate {
    id: string;
    updates: Partial<ComponentState>;
}

export interface MessageData {
    toolName?: ComponentType;
    componentProps?: any;
    isDetailsCard?: boolean;
}

export interface ChatMessage extends Omit<AiMessage, 'data'> {
    data?: MessageData;
}

export type ToolResponse<T extends ComponentType> = {
    type: T;
    props: ComponentProps[T];
    message?: string;
}

// Session Types
export interface TravelSession {
    // Session info
    sessionId: string;
    startTime: number;
    lastActive: number;
    expiresAt: number;

    // Travel details
    destination: string;
    startDate: string;
    endDate: string;
    preferences: string[];
    budget: string;
    language: string;
    transport: string[];
    location?: {
        latitude: number;
        longitude: number;
    };

    // Places
    savedPlaces: any[];
    currentStage: number;

    // Metrics
    totalPrompts: number;
    stagePrompts: Record<number, number>;
    savedPlacesCount: number;
    
    // Payment
    isPaid: boolean;
    paymentReference: string;
    paymentTimestamp?: number;
}

export type ChatState = 'initial' | 'gathering_info' | 'planning' | 'interrupted' | 'completed';

export interface AIResponse {
    message: string;
    parameters?: TravelDetails;
    suggestedAction?: string;
    error?: string;
}

export interface CacheConfig {
    maxSize: number;
    ttl: number; // Time to live in milliseconds
}

export interface CacheEntry {
    content: string;
    timestamp: number;
    language: string;
}

export interface ContentResponse {
    content: string;
    cached: boolean;
    language: string;
    generated: Date;
}

export interface ToolInvocation {
    toolName: string;
    toolCallId: string;
    state: 'result' | 'pending' | 'error';  
    args: JSONValue;  
    result?: {
        type: string;
        props: Record<string, unknown>;  
    };
    error?: string;  
}

export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';  
    content: string;
    createdAt?: Date;  
    data?: MessageData;
    toolInvocations?: ToolInvocation[];
    parentMessageId?: string;  
}

// Weather related types
export interface WeatherData {
    date: string;
    precipitation: {
        total: number;
    };
    temperature: {
        max: number;
    };
}

export interface WeatherChartProps {
    lat: number;
    lon: number;
    city: string;
    startDate: string;
    endDate: string;
    units?: 'us' | 'uk' | 'metric';
}

export interface OpenWeatherDayResponse {
    lat: number;
    lon: number;
    tz: string;
    date: string;
    units: string;
    cloud_cover: {
    afternoon: number;
    };
    humidity: {
    afternoon: number;
    };
    precipitation: {
    total: number;
    };
    temperature: {
    min: number;
    max: number;
    afternoon: number;
    night: number;
    evening: number;
    morning: number;
    };
    pressure: {
    afternoon: number;
    };
    wind: {
    max: {
        speed: number;
        direction: number;
    }
    }
}

export interface WeatherResponse {
    data: OpenWeatherDayResponse;
    year: number;  // Add this field
    error?: string;
}

// Currency related types
export interface CurrencyRate {
    code: string;
    name: string;
    rate: number;
    symbol?: string;
}

export interface CurrencyConverterProps {
    baseCurrency?: string;
    baseAmount?: number;
    onAmountChange?: (amount: number) => void;
    defaultCurrencies?: string[];
}

export interface CurrencyInfo {
    name: string;
    symbol: string;
    position: 'before' | 'after';
}

export const CURRENCY_INFO: { [key: string]: CurrencyInfo } = {
    'USD': { name: 'US Dollar', symbol: '$', position: 'before' },
    'EUR': { name: 'Euro', symbol: '€', position: 'before' },
    'GBP': { name: 'British Pound', symbol: '£', position: 'before' },
    'CNY': { name: 'Chinese Yuan', symbol: '¥', position: 'before' },
    'JPY': { name: 'Japanese Yen', symbol: '¥', position: 'before' },
    'SGD': { name: 'Singapore Dollar', symbol: 'S$', position: 'before' },
    'MYR': { name: 'Malaysian Ringgit', symbol: 'RM', position: 'before' },
    'KRW': { name: 'South Korean Won', symbol: '₩', position: 'before' },
    'AUD': { name: 'Australian Dollar', symbol: 'A$', position: 'before' },
    'CAD': { name: 'Canadian Dollar', symbol: 'C$', position: 'before' }
};

export interface CurrencyCache {
    timestamp: number;
    rates: Record<string, number>;
    baseCurrency: string;
}

export interface CurrencyApiResponse {
    data: { [key: string]: number };
}

export const DEFAULT_CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY', 'JPY'];

export interface StageProgressResult {
    type: 'stageProgress';
    props: {
        nextStage: number;
        reason: string;
        criteria: string[];
    };
}
