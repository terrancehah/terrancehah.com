import { CurrencyCache, CURRENCY_INFO } from '@/managers/types';

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const CACHE_KEY = 'currency_cache';

export async function fetchExchangeRates(baseCurrency: string): Promise<{ [key: string]: number }> {
    // Try to get cached data first
    const cachedData = getCachedRates(baseCurrency);
    if (cachedData) {
        return cachedData;
    }

    try {
        const response = await fetch(
            `/api/currency/rates?baseCurrency=${encodeURIComponent(baseCurrency)}`,
            {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                // Add cache control
                cache: 'no-cache',
                credentials: 'same-origin',
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (!data.data || typeof data.data !== 'object') {
            throw new Error('Invalid API response format');
        }
        
        // Cache the response
        const cache: CurrencyCache = {
            timestamp: Date.now(),
            rates: data.data,
            baseCurrency
        };
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));

        return data.data;
    } catch (error) {
        console.error('Error fetching exchange rates:', error);
        throw error;
    }
}

export function getCachedRates(baseCurrency: string): { [key: string]: number } | null {
    try {
        const cacheStr = sessionStorage.getItem(CACHE_KEY);
        if (!cacheStr) return null;

        const cache: CurrencyCache = JSON.parse(cacheStr);
        
        // Check if cache is expired or for a different base currency
        if (
            Date.now() - cache.timestamp > CACHE_DURATION ||
            cache.baseCurrency !== baseCurrency
        ) {
            sessionStorage.removeItem(CACHE_KEY);
            return null;
        }

        return cache.rates;
    } catch {
        return null;
    }
}

export function formatCurrencyAmount(amount: number, currency: string): string {
    const info = CURRENCY_INFO[currency];
    if (!info) return `${currency} ${amount.toFixed(2)}`;

    const { symbol, position } = info;
    const formatted = amount.toFixed(2);

    return position === 'before' ? `${symbol}${formatted}` : `${formatted} ${symbol}`;
}

export function getCurrencyFromCountry(country: string): string {
    // Map countries to their currencies
    const countryToCurrency: { [key: string]: string } = {
        'Singapore': 'SGD',
        'Malaysia': 'MYR',
        'United States': 'USD',
        'Japan': 'JPY',
        'China': 'CNY',
        'United Kingdom': 'GBP',
        'European Union': 'EUR',
        'Australia': 'AUD',
        'Canada': 'CAD',
        'South Korea': 'KRW',
        // Add more as needed
    };

    // Extract country from destination string (e.g., "Tokyo, Japan" -> "Japan")
    const parts = country.split(',');
    const countryName = parts[parts.length - 1]?.trim() || country.trim();
    
    return countryToCurrency[countryName] || 'USD'; // Default to USD if country not found
}
