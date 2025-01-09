import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { buffer } from 'micro';

// Initialize Stripe with proper typing
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
});

// This is necessary to handle raw body for Stripe webhooks
export const config = {
  api: {
    bodyParser: false,
  },
};

// Type for our response structure
type WebhookResponse = {
  received: boolean;
  message?: string;
  client_reference_id?: string;
}

// Rate limiting configuration
const RATE_LIMIT = 100; // requests
const TIME_WINDOW = 60 * 1000; // 1 minute in ms
const requests = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - TIME_WINDOW;
  
  // Get or initialize timestamps for this IP
  const timestamps = requests.get(ip) || [];
  // Keep only timestamps within current window
  const windowTimestamps = timestamps.filter(time => time > windowStart);
  
  // Update timestamps
  windowTimestamps.push(now);
  requests.set(ip, windowTimestamps);
  
  return windowTimestamps.length > RATE_LIMIT;
}

// Track processed events in memory
const processedEvents = new Set<string>();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Get IP from headers
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const ipStr = Array.isArray(ip) ? ip[0] : ip;
  
  if (isRateLimited(ipStr)) {
    return res.status(429).json({ received: false, message: 'Too many requests' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ received: false, message: 'Method not allowed' });
  }

  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).json({ received: false, message: 'No signature provided' });
  }

  try {
    console.log('[Webhook] Received request');
    const rawBody = await buffer(req);
    let event: Stripe.Event;

    try {
      console.log('[Webhook] Verifying signature');
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
      // Log the full raw event for debugging
      console.log('[Webhook] Raw event:', JSON.stringify(event, null, 2));
      console.log('[Webhook] Event received:', event.type);
      console.log('[Webhook] Event details:', {
        type: event.type,
        id: event.id,
        apiVersion: event.api_version,
        created: new Date(event.created * 1000).toISOString()
      });
    } catch (err) {
      const error = err as Error;
      console.error('[Webhook] Signature verification failed:', error.message);
      return res.status(400).json({ received: false, message: 'Invalid signature' });
    }

    // Check for duplicate events
    if (processedEvents.has(event.id)) {
      console.log(`[Webhook] Duplicate event detected: ${event.id}`);
      return res.status(200).json({ received: true, message: 'Event already processed' });
    }

    // Handle the event
    if (event.type === 'checkout.session.completed') {
      console.log('[Webhook] Processing checkout session');
      const session = event.data.object as Stripe.Checkout.Session;
      
      // Log the full session object for debugging
      console.log('[Webhook] Full session data:', JSON.stringify(session, null, 2));
      
      console.log('[Webhook] Session data:', JSON.stringify({
        id: session.id,
        payment_status: session.payment_status,
        client_reference_id: session.client_reference_id
      }, null, 2));
      console.log('[Webhook] Checkout session details:', {
        id: session.id,
        paymentStatus: session.payment_status,
        clientReferenceId: session.client_reference_id,
        customerId: session.customer,
        amount: session.amount_total,
        currency: session.currency
      });
      
      if (session.payment_status === 'paid') {
        if (!session.client_reference_id) {
          console.error('[Webhook] Payment successful but no client reference ID provided');
          return res.status(200).json({ received: true, message: 'Missing client reference ID' });
        }
        
        const clientReferenceId: string = session.client_reference_id;
        
        try {
          // Store the payment success in session metadata
          await stripe.checkout.sessions.update(session.id, {
            metadata: {
              payment_verified: 'true',
              client_reference_id: clientReferenceId,
              verified_at: new Date().toISOString()
            }
          });
          
          console.log('[Webhook] Payment verified and stored for session:', clientReferenceId);
          
          // Mark event as processed
          processedEvents.add(event.id);
          
          return res.status(200).json({ 
            received: true, 
            message: 'Payment verified',
            client_reference_id: clientReferenceId 
          });
        } catch (error) {
          console.error('[Webhook] Error storing payment verification:', error);
          return res.status(500).json({ received: false, message: 'Error storing payment verification' });
        }
      }
    } else if (event.type === 'charge.failed') {
      console.error(`[Webhook] Payment failed for charge: ${event.data.object.id}`);
      return res.status(200).json({ received: true, message: 'Payment failed' });
    }

    // Mark event as processed
    processedEvents.add(event.id);

    // Prevent memory leaks by limiting set size
    if (processedEvents.size > 1000) {
      const iterator = processedEvents.values();
      const firstValue = iterator.next().value;
      if (firstValue) {
        processedEvents.delete(firstValue);
      }
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    const error = err as Error;
    console.error('[Webhook] Error occurred:', error.message);
    return res.status(500).json({ received: false, message: 'Internal server error' });
  }
}