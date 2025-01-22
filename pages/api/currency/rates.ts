import type { NextApiRequest, NextApiResponse } from 'next';

type ResponseData = {
    data?: { [key: string]: number };
    error?: string;
    details?: any;
};

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<ResponseData>
) {
    console.log('Currency API Request:', {
        method: req.method,
        query: req.query,
        headers: req.headers
    });

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight request
    if (req.method === 'OPTIONS') {
        console.log('Handling OPTIONS request');
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        console.log('Invalid method:', req.method);
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { baseCurrency } = req.query;

    if (!baseCurrency || Array.isArray(baseCurrency)) {
        console.log('Invalid base currency:', baseCurrency);
        return res.status(400).json({ error: 'Base currency is required' });
    }

    const apiKey = process.env.FREECURRENCY_API_KEY;
    if (!apiKey) {
        console.error('FreeCurrency API key not configured');
        return res.status(500).json({ error: 'FreeCurrency API key is not configured' });
    }

    try {
        console.log('Fetching rates for currency:', baseCurrency);
        const response = await fetch(
            `https://api.freecurrencyapi.com/v1/latest?apikey=${apiKey}&base_currency=${baseCurrency}`,
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            console.error('FreeCurrency API error:', {
                status: response.status,
                statusText: response.statusText,
                errorData
            });
            return res.status(response.status).json({ 
                error: `Failed to fetch exchange rates: ${response.status} ${response.statusText}`,
                details: errorData
            });
        }

        const data = await response.json();
        console.log('Successfully fetched rates');
        
        // Set cache headers
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
        
        return res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching exchange rates:', error);
        return res.status(500).json({ error: 'Failed to fetch exchange rates' });
    }
}
