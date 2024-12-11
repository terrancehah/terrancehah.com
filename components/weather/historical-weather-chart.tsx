'use client';

import { useState } from "react"
import { Bar, Line, ComposedChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { WeatherData, WeatherChartProps } from "@/managers/types"

interface ChartDataPoint {
  date: string;
  tempMax: number;
  precipitation: number;
  monthYear: string;
}

interface OpenWeatherDayResponse {
  date: string;
  temperature: {
    max: number;
  };
  precipitation: {
    total: number;
  };
}

// Generate sample weather data for 30 days following OpenWeather API format
const generateWeatherData = (days: number): OpenWeatherDayResponse[] => {
  const data: OpenWeatherDayResponse[] = []
  const now = new Date()
  const startDate = new Date(now.getFullYear() - 1, now.getMonth(), 1) // Same month last year
  
  for (let i = 0; i < days; i++) {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + i)
    
    data.push({
      date: date.toISOString().split('T')[0],
      temperature: {
        max: Math.round(Math.random() * 10 + 15), // Random temperature between 15-25°C
      },
      precipitation: {
        total: Math.round(Math.random() * 20), // Random precipitation between 0-20mm
      },
    })
  }
  return data
}

// Transform API data to chart format
const transformWeatherData = (data: OpenWeatherDayResponse[]): ChartDataPoint[] => {
  // Get the month and year from the last date in the data
  const lastDate = new Date(data[data.length - 1].date);
  const monthYear = lastDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return data.map(day => ({
    date: day.date, // Keep the full date for tooltip
    tempMax: day.temperature.max,
    precipitation: day.precipitation.total,
    monthYear // Add the month-year label to be used in the chart
  }))
}

export default function HistoricalWeatherChart({ lat, lon, city, units = 'metric', initialData }: WeatherChartProps) {
  // Use initialData if provided, otherwise use sample data for 30 days
  const weatherData = transformWeatherData(initialData || generateWeatherData(30))
  const monthYear = weatherData[0].monthYear

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{city} Weather History</CardTitle>
        <CardDescription className="text-sm">30-day historical data from {monthYear}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[250px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={weatherData} margin={{ top: 15, right: 30, left: 25, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="date"
                axisLine={true}
                tickLine={false}
                tick={false}
                height={30}
                label={{ 
                  value: monthYear,
                  position: 'insideBottom',
                  offset: 0,
                  style: { textAnchor: 'middle' }
                }}
              />
              <YAxis 
                yAxisId="temp"
                orientation="left"
                domain={[0, 40]}
                tick={{ fontSize: 12 }}
                label={{ 
                  value: 'Temperature (°C)', 
                  angle: -90, 
                  position: 'insideLeft',
                  offset: 10,
                  style: { textAnchor: 'middle' }
                }}
              />
              <YAxis 
                yAxisId="precip"
                orientation="right"
                domain={[0, 'auto']}
                tick={{ fontSize: 12 }}
                label={{ 
                  value: 'Precipitation (mm)', 
                  angle: 90, 
                  position: 'insideRight',
                  offset: 10,
                  style: { textAnchor: 'middle' }
                }}
              />
              <ChartTooltip />
              <Bar 
                dataKey="precipitation" 
                fill="#E2E8F0"  
                yAxisId="precip"
                name="Precipitation"
                opacity={0.7}
              />
              <Line
                type="monotone"
                dataKey="tempMax"
                stroke="#0EA5E9"  
                strokeWidth={2.5}  
                yAxisId="temp"
                name="Max Temperature"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
