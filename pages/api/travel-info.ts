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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { origin, destination } = req.body as RouteRequest

    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY!,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
      },
      body: JSON.stringify({
        origin,
        destination,
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        computeAlternativeRoutes: false,
        languageCode: "en-US",
        routeModifiers: {
          avoidTolls: false,
          avoidHighways: false,
          avoidFerries: false
        }
      })
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('[travel-info] Google API Error:', error)
      throw new Error('Failed to fetch route')
    }

    const data = await response.json()
    if (!data.routes?.[0]) {
      throw new Error('No route found')
    }

    return res.status(200).json({
      duration: data.routes[0].duration,
      distanceMeters: data.routes[0].distanceMeters
    })
  } catch (error) {
    console.error('[travel-info] Error:', error)
    return res.status(500).json({ error: 'Failed to compute route' })
  }
}
