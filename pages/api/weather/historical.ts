import { NextRequest } from 'next/server';
import { WeatherResponse, OpenWeatherDayResponse } from '@/managers/types';

// Define types for the API response
interface ErrorResponse {
  error: string;
}

// Helper function to validate date range
const isValidDateRange = (startDate: string, endDate: string) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const minDate = new Date('1979-01-02');
  const maxDate = new Date('2024-12-11T03:04:40+08:00'); // Use current time

  return (
    start >= minDate &&
    end <= maxDate &&
    start <= end &&
    end.getTime() - start.getTime() <= 31 * 24 * 60 * 60 * 1000 // Max 31 days (one month)
  );
};

// Helper function to validate coordinates
const isValidCoordinates = (lat: number, lon: number) => {
  return !isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
};

export const config = {
  runtime: 'edge'
};

const BASE_URL = 'https://api.openweathermap.org/data/3.0/onecall/day_summary';

// Helper function to fetch weather data for a single date
async function fetchDailyWeather(
  lat: number,
  lon: number,
  date: string,
  units: string = 'metric'
): Promise<WeatherResponse> {
  const apiKey = process.env.NEXT_PUBLIC_OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing NEXT_PUBLIC_OPENWEATHER_API_KEY environment variable');
  }

  // Format coordinates to 6 decimal places
  const formattedLat = lat.toFixed(6);
  const formattedLon = lon.toFixed(6);

  // Format date to YYYY-MM-DD
  const formattedDate = new Date(date).toISOString().split('T')[0];

  const url = `${BASE_URL}?lat=${formattedLat}&lon=${formattedLon}&date=${formattedDate}&units=${units}&appid=${apiKey}`;
  console.log('[fetchDailyWeather] Fetching from URL:', url.replace(apiKey, '[REDACTED]'));
  
  const response = await fetch(url);
  console.log('[fetchDailyWeather] Response status:', response.status);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[fetchDailyWeather] API error:', errorText);
    throw new Error(`Weather API error: ${response.statusText}`);
  }

  const data = await response.json() as OpenWeatherDayResponse;
  console.log('[fetchDailyWeather] Weather data for', date, ':', data);
  
  return {
    data: {
      date: data.date,
      precipitation: {
        total: data.precipitation?.total || 0
      },
      temperature: {
        max: data.temperature?.max || 0
      }
    }
  };
}

export default async function handler(
  req: NextRequest
) {
  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405 }
    );
  }

  try {
    const url = new URL(req.url);
    const lat = parseFloat(url.searchParams.get('lat') || '');
    const lon = parseFloat(url.searchParams.get('lon') || '');
    const startDate = url.searchParams.get('startDate') || '';
    const endDate = url.searchParams.get('endDate') || '';
    const units = url.searchParams.get('units') || 'metric';

    console.log('[historical] Request parameters:', {
      lat,
      lon,
      startDate,
      endDate,
      units
    });

    // Validate required parameters
    if (!lat || !lon || !startDate || !endDate) {
      console.error('[historical] Missing required parameters');
      return new Response(
        JSON.stringify({
          error: 'Missing required parameters: lat, lon, startDate, endDate'
        }),
        { status: 400 }
      );
    }

    // Validate coordinates
    if (!isValidCoordinates(lat, lon)) {
      console.error('[historical] Invalid coordinates');
      return new Response(
        JSON.stringify({
          error: 'Invalid coordinates. Latitude must be between -90 and 90, longitude between -180 and 180'
        }),
        { status: 400 }
      );
    }

    // Validate units
    if (units && !['standard', 'metric', 'imperial'].includes(units)) {
      console.error('[historical] Invalid units');
      return new Response(
        JSON.stringify({
          error: 'Invalid units. Must be one of: standard, metric, imperial'
        }),
        { status: 400 }
      );
    }

    // Validate date range
    if (!isValidDateRange(startDate, endDate)) {
      console.error('[historical] Invalid date range');
      return new Response(
        JSON.stringify({
          error: 'Invalid date range. Dates must be between 1979-01-02 and today, and the range must not exceed 31 days'
        }),
        { status: 400 }
      );
    }

    // Generate array of dates between start and end
    const dates: string[] = [];
    let currentDate = new Date(startDate);
    const end = new Date(endDate);
    
    while (currentDate <= end) {
      dates.push(currentDate.toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log('[historical] Dates to fetch:', dates);

    // Fetch weather data for each date
    const weatherPromises = dates.map(date =>
      fetchDailyWeather(lat, lon, date, units)
    );

    const weatherData = await Promise.all(weatherPromises);
    console.log('[historical] All weather data fetched:', weatherData);

    return new Response(
      JSON.stringify(weatherData),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

  } catch (error) {
    console.error('[historical] Error fetching weather data:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch weather data',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      { 
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
}
