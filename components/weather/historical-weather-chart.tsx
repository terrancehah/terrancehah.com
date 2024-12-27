///Users/terrancehah/Documents/terrancehah.com/components/weather/historical-weather-chart.tsx

'use client';

import { useState, useEffect } from "react"
import { Bar, Line, ComposedChart, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { OpenWeatherDayResponse, WeatherChartProps, WeatherResponse } from "@/managers/types"

interface ChartDataPoint {
  date: string;
  temp: number;
  precipitation: number;
}

export default function HistoricalWeatherChart({ lat, lon, city, startDate, endDate, units = 'metric' }: WeatherChartProps) {
  const [weatherData, setWeatherData] = useState<ChartDataPoint[]>([]);
  const [historicalYear, setHistoricalYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const response = await fetch(
          `/api/weather/historical?lat=${lat}&lon=${lon}&startDate=${startDate}&endDate=${endDate}&units=${units}`
        );
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to fetch weather data');
        }

        const { data, year } = await response.json();
        
        // Transform API response to chart data format
        const chartData = data.map((item: WeatherResponse) => ({
          date: new Date(item.data.date).toLocaleDateString(),
          temp: item.data.temperature.max,
          precipitation: item.data.precipitation.total
        }));

        setWeatherData(chartData);
        setHistoricalYear(year);
      } catch (err) {
        console.error('Weather chart error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load weather data');
      } finally {
        setLoading(false);
      }
    };

    if (lat && lon && startDate && endDate) {
      fetchWeather();
    }
  }, [lat, lon, startDate, endDate, units]);

  if (loading) return <div></div>;
  if (error) return <div></div>;

  const tempUnit = units === 'us' ? '°F' : '°C';
  const precipUnit = 'mm';

  // Get the year we're showing data for
  const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const formattedStartDate = dateFormatter.format(new Date(startDate));
  const formattedEndDate = dateFormatter.format(new Date(endDate));

  return (
    <div className="w-[80%] max-w-lg mx-auto rounded-3xl border border-gray-100 shadow-md">
      <CardHeader>
        <CardTitle>{city} Historical Weather</CardTitle>
        <CardDescription className="text-sm text-gray-500">
          from {formattedStartDate} to {formattedEndDate}, {historicalYear}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ChartContainer
          config={{
            temp: {
              label: "Temperature",
              color: "hsl(var(--primary))",
            },
            precipitation: {
              label: "Precipitation",
              color: "hsl(var(--blue-100))",
            },
          }}
          className="h-[200px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={weatherData}
              margin={{
                top: 10,
                right: 10,
                bottom: 10,
                left: 10,
              }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.5} vertical={false} />
              <XAxis 
                dataKey="date"
                axisLine={{ stroke: 'rgb(226 232 240)' }}
                tick={false}
                tickLine={false}
              />
              <YAxis className="text-xs"
                yAxisId="temp"
                orientation="left"
                tickFormatter={(value) => `${value}${tempUnit}`}
                domain={[0, 40]}
                ticks={[0, 10, 20, 30, 40]}
                tick={{ fill: 'rgb(100 116 139)' }}
                axisLine={{ stroke: 'rgb(226 232 240)' }}
                tickLine={{ stroke: 'rgb(226 232 240)' }}
              />
              <YAxis className="text-xs"
                yAxisId="precipitation"
                orientation="right"
                tickFormatter={(value) => `${value}${precipUnit}`}
                domain={[0, 'auto']}
                tick={{ fill: 'rgb(100 116 139)' }}
                axisLine={{ stroke: 'rgb(226 232 240)' }}
                tickLine={{ stroke: 'rgb(226 232 240)' }}
              />
              <ChartTooltip />
              <Bar
                dataKey="precipitation"
                yAxisId="precipitation"
                fill="rgb(219 234 254)" // bg-blue-100
                opacity={0.7}
                barSize={40}
              />
              <Line
                type="natural"
                dataKey="temp"
                yAxisId="temp"
                stroke="rgb(74 136 198)" // sky-blue
                strokeWidth={3}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </div>
  );
}