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
    if (!place1?.location || !place2?.location) {
      console.log('[TravelInfoManager] Missing location:', {
        place1: place1?.displayName,
        place2: place2?.displayName,
        loc1: place1?.location,
        loc2: place2?.location
      });
      return { duration: '--', distance: '--', timestamp: Date.now(), error: true }
    }

    const key = this.getCacheKey(place1, place2)
    const cached = this.cache[key]

    if (cached && this.isCacheValid(cached)) {
      console.log('[TravelInfoManager] Using cached info for:', {
        from: place1.displayName,
        to: place2.displayName
      });
      return cached
    }

    try {
      console.log('[TravelInfoManager] Fetching new info for:', {
        from: place1.displayName,
        to: place2.displayName
      });
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

      if (!response.ok) {
        console.error('[TravelInfoManager] API Error:', response.status);
        return { duration: '--', distance: '--', timestamp: Date.now(), error: true };
      }
      
      const data = await response.json()
      if (data.error) {
        console.error('[TravelInfoManager] Data Error:', data.error);
        return { duration: '--', distance: '--', timestamp: Date.now(), error: true };
      }

      console.log('[TravelInfoManager] Raw API response:', data);

      const info: TravelInfo = {
        duration: data.duration || '--',
        distance: data.distance || '--',
        timestamp: Date.now(),
        polyline: data.polyline,
        legPolyline: data.legPolyline
      }

      // Only cache if we have valid data
      if (data.duration && data.distance && !data.duration.includes('NaN') && !data.distance.includes('NaN')) {
        this.cache[key] = info;
        this.persist();
      } else {
        console.error('[TravelInfoManager] Invalid data received:', data);
      }

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

  // Add this new method to clear routes for specific places
  clearRoutesForPlace(place: Place): void {
    // Clear all routes that involve this place
    Object.keys(this.cache).forEach(key => {
      if (key.includes(place.id)) {
        delete this.cache[key];
      }
    });
    
    // Update localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this.cache));
    }
  }
}

export const travelInfoManager = new TravelInfoManager()
