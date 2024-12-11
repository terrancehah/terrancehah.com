import { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
    console.log('API Route: Received request for Maps API key');
    
    if (req.method !== 'GET') {
        console.error('API Route: Invalid method:', req.method);
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        console.log('API Route: Checking for Google Maps API key...');
        const apiKey = process.env.GOOGLE_MAPS_API_KEY;
        
        if (!apiKey) {
            console.error('API Route: Google Maps API key not found in environment variables');
            return res.status(500).json({ 
                error: 'Google Maps API key not configured',
                debug: {
                    envVars: Object.keys(process.env).filter(key => key.includes('GOOGLE')),
                    hasKey: !!process.env.GOOGLE_MAPS_API_KEY,
                    env: process.env.NODE_ENV
                }
            });
        }

        console.log('API Route: Google Maps API key found, length:', apiKey.length);
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({ key: apiKey });
    } catch (error) {
        console.error('API Route: Error in maps-key API:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
