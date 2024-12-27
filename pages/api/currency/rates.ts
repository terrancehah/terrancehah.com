import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const { baseCurrency } = req.query;

    if (!baseCurrency || typeof baseCurrency !== 'string') {
        return res.status(400).json({ error: 'Base currency is required' });
    }

    const apiKey = process.env.FREECURRENCY_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'FreeCurrency API key is not configured' });
    }

    try {
        const response = await fetch(
            `https://api.freecurrencyapi.com/v1/latest?apikey=${apiKey}&base_currency=${baseCurrency}`
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
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching exchange rates:', error);
        res.status(500).json({ error: 'Failed to fetch exchange rates' });
    }
}
