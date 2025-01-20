import { Place } from './places-utils'

interface TravelInfo {
  duration: string
  distance: string
  timestamp: number
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
      const stored = localStorage.getItem(CACHE_KEY)
      if (stored) {
        this.cache = JSON.parse(stored)
      }
    }
  }

  private getCacheKey(place1: Place, place2: Place): string {
    return `${place1.id}-${place2.id}`
  }

  private isCacheValid(timestamp: number): boolean {
    return Date.now() - timestamp < CACHE_DURATION
  }

  async getTravelInfo(place1: Place, place2: Place): Promise<TravelInfo | null> {
    if (!place1.location || !place2.location) return null

    const key = this.getCacheKey(place1, place2)
    const cached = this.cache[key]

    if (cached && this.isCacheValid(cached.timestamp)) {
      return cached
    }

    try {
      const response = await fetch('/api/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: {
            latitude: place1.location.latitude,
            longitude: place1.location.longitude
          },
          destination: {
            latitude: place2.location.latitude,
            longitude: place2.location.longitude
          }
        })
      })

      if (!response.ok) throw new Error('Failed to fetch route')
      
      const data = await response.json()
      const info: TravelInfo = {
        duration: `${Math.round(parseInt(data.duration) / 60)} mins`,
        distance: `${(data.distanceMeters / 1000).toFixed(1)} km`,
        timestamp: Date.now()
      }

      this.cache[key] = info
      this.persist()
      return info
    } catch (error) {
      console.error('[TravelInfoManager] Error:', error)
      return {
        duration: '--',
        distance: '--',
        timestamp: Date.now()
      }
    }
  }

  private persist(): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this.cache))
    }
  }

  clearCache(): void {
    this.cache = {}
    this.persist()
  }
}

export const travelInfoManager = new TravelInfoManager()
