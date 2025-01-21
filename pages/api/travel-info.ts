import { NextApiRequest, NextApiResponse } from 'next'

interface LatLng {
  latitude: number
  longitude: number
}

interface RouteRequest {
  origin: {
    location: {
      latLng: LatLng
    }
  }
  destination: {
    location: {
      latLng: LatLng
    }
  }
}

function formatDuration(duration: any) {
  // implement duration formatting logic here
  return duration;
}

function formatDistance(distance: any) {
  // implement distance formatting logic here
  return distance;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { origin, destination } = req.body as RouteRequest
    console.log('[travel-info] Request:', { origin, destination });

    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY!,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.polyline.encodedPolyline'
      },
      body: JSON.stringify({
        origin: {
          location: {
            latLng: origin.location.latLng
          }
        },
        destination: {
          location: {
            latLng: destination.location.latLng
          }
        },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        polylineQuality: "HIGH_QUALITY",
        polylineEncoding: "ENCODED_POLYLINE"
      })
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('[travel-info] Google API Error:', error)
      throw new Error(`Failed to fetch route: ${error}`)
    }

    const data = await response.json()
    console.log('[travel-info] Route data:', data);
    
    if (!data.routes?.[0]) {
      throw new Error('No route found')
    }

    // Extract route info
    const route = data.routes[0]
    const duration = route.duration
    const distance = route.distanceMeters

    // Get the polylines
    const polyline = route.polyline?.encodedPolyline
    const legPolyline = route.legs?.[0]?.polyline?.encodedPolyline

    return res.json({
      duration: formatDuration(duration),
      distance: formatDistance(distance),
      timestamp: Date.now(),
      polyline,
      legPolyline
    })
  } catch (error) {
    console.error('[travel-info] Error:', error)
    return res.status(500).json({ error: 'Failed to compute route' })
  }
}
