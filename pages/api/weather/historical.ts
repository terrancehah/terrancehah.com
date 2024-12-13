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
  const minDate = new Date('1970-01-01');  // Visual Crossing supports data from 1970
  const maxDate = new Date(); // Current date since we're using historical data

  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return false;
  }

  return (
    start >= minDate &&
    end <= maxDate &&
    start <= end &&
    daysDiff <= 31  // Allow up to 31 days
  );
};

// Helper function to validate coordinates
const isValidCoordinates = (lat: number, lon: number) => {
  return !isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
};

// Helper function to get dates from previous year
const getPreviousYearDates = (startDate: string, endDate: string) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
 // Subtract one year from each date separately
  start.setFullYear(start.getFullYear() - 1);
  end.setFullYear(end.getFullYear() - 1);

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
    year: start.getFullYear() // Use start date's year for display
  };
};

export const config = {
  runtime: 'edge'
};

const BASE_URL = 'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline';

async function fetchDailyWeather(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
  units: string = 'metric'
): Promise<WeatherResponse[]> {
  const apiKey = process.env.NEXT_PUBLIC_VISUALCROSSING_API_KEY;
  if (!apiKey) {
    throw new Error('Missing NEXT_PUBLIC_VISUALCROSSING_API_KEY environment variable');
  }

  const url = `${BASE_URL}/${lat},${lon}/${startDate}/${endDate}?key=${apiKey}&unitGroup=${units}&include=days&elements=datetime,tempmax,precip`;
  
  console.log('[fetchDailyWeather] Fetching from URL:', url.replace(apiKey, '[REDACTED]'));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather API responded with status: ${response.status}`);
  }

  const data = await response.json();
  
  // Transform the data to match our expected format
  return data.days.map((day: any) => ({
    data: {
      date: day.datetime,
      temperature: {
        max: day.tempmax
      },
      precipitation: {
        total: day.precip
      }
    }
  }));
}

export default async function handler(
  req: NextRequest
) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = parseFloat(searchParams.get('lat') || '');
    const lon = parseFloat(searchParams.get('lon') || '');
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';
    const units = searchParams.get('units') || 'metric';

    console.log('[historical] Original dates:', { startDate, endDate });

    // Get dates from previous year
    const historicalDates = getPreviousYearDates(startDate, endDate);
    
    console.log('[historical] Historical dates:', historicalDates);

    // Validate parameters
    if (!lat || !lon || !startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters' }),
        { status: 400 }
      );
    }

    if (!isValidCoordinates(lat, lon)) {
      return new Response(
        JSON.stringify({ error: 'Invalid coordinates' }),
        { status: 400 }
      );
    }

    if (!isValidDateRange(historicalDates.startDate, historicalDates.endDate)) {
      return new Response(
        JSON.stringify({ error: 'Invalid date range for historical data' }),
        { status: 400 }
      );
    }

    const weatherData = await fetchDailyWeather(lat, lon, historicalDates.startDate, historicalDates.endDate, units);

    return new Response(JSON.stringify({
      data: weatherData,
      year: historicalDates.year
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Weather API Error]:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500 }
    );
  }
}
