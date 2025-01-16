import { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
    console.log('[Maps API] Received request for Maps API key');
    
    // Set CORS and caching headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/json');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'GET') {
        console.error('[Maps API] Invalid method:', req.method);
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        console.log('[Maps API] Checking for Google Maps API key...');
        const apiKey = process.env.GOOGLE_MAPS_API_KEY;
        
        if (!apiKey) {
            console.error('[Maps API] Google Maps API key not found in environment variables');
            return res.status(500).json({ 
                error: 'Google Maps API key not configured',
                debug: {
                    envVars: Object.keys(process.env).filter(key => key.includes('GOOGLE')),
                    hasKey: !!process.env.GOOGLE_MAPS_API_KEY,
                    env: process.env.NODE_ENV
                }
            });
        }

        console.log('[Maps API] Google Maps API key found, length:', apiKey.length);
        return res.status(200).json({ key: apiKey });
    } catch (error) {
        console.error('[Maps API] Error in maps-key API:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
