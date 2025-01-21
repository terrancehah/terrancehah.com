import { Place } from './places-utils'

interface TravelInfo {
  duration: string
  distance: string
  timestamp: number
  error?: boolean
  polyline?: string
  legPolyline?: string
}

interface TravelInfoCache {
  [key: string]: TravelInfo
}

const CACHE_KEY = 'travel_info_cache'
const CACHE_DURATION = 24 * 60 * 60 * 1000 // 24 hours

class TravelInfoManager {
  private cache: TravelInfoCache = {}

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(CACHE_KEY)
        if (stored) {
          this.cache = JSON.parse(stored)
        }
      } catch (error) {
        console.error('[TravelInfoManager] Cache load error:', error)
        this.cache = {}
      }
    }
  }

  private getCacheKey(place1: Place, place2: Place): string {
    return `${place1.id}-${place2.id}`
  }

  private isCacheValid(info: TravelInfo): boolean {
    return !info.error && Date.now() - info.timestamp < CACHE_DURATION
  }

  async getTravelInfo(place1: Place, place2: Place): Promise<TravelInfo> {
    if (!place1.location || !place2.location) {
      return { duration: '--', distance: '--', timestamp: Date.now(), error: true }
    }

    const key = this.getCacheKey(place1, place2)
    const cached = this.cache[key]

    if (cached && this.isCacheValid(cached)) {
      return cached
    }

    try {
      const response = await fetch('/api/travel-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: place1.location.latitude,
                longitude: place1.location.longitude
              }
            }
          },
          destination: {
            location: {
              latLng: {
                latitude: place2.location.latitude,
                longitude: place2.location.longitude
              }
            }
          }
        })
      })

      if (!response.ok) throw new Error('Failed to fetch route')
      
      const data = await response.json()
      if (data.error) throw new Error(data.error)

      // Convert seconds to minutes and round
      const minutes = Math.round(parseInt(data.duration.replace('s', '')) / 60)
      // Convert meters to km and round to 1 decimal
      const km = (data.distanceMeters / 1000).toFixed(1)

      const info: TravelInfo = {
        duration: `${minutes} mins`,
        distance: `${km} km`,
        timestamp: Date.now(),
        polyline: data.polyline,
        legPolyline: data.legPolyline
      }

      this.cache[key] = info
      this.persist()
      return info
    } catch (error) {
      console.error('[TravelInfoManager] Error:', error)
      const errorInfo = { duration: '--', distance: '--', timestamp: Date.now(), error: true }
      this.cache[key] = errorInfo
      return errorInfo
    }
  }

  private persist(): void {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(this.cache))
      } catch (error) {
        console.error('[TravelInfoManager] Cache save error:', error)
      }
    }
  }

  clearCache(): void {
    this.cache = {}
    this.persist()
  }
}

export const travelInfoManager = new TravelInfoManager()
