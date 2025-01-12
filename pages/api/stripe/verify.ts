import { NextRequest } from 'next/server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
});

export const config = {
  runtime: 'edge'
};

export default async function handler(req: NextRequest) {
  console.log('[Verify] Received verification request');
  
  if (req.method !== 'POST') {
    console.log('[Verify] Invalid method:', req.method);
    return new Response(
      JSON.stringify({ isPaid: false, message: 'Method not allowed' }), 
      { status: 405, headers: { 'Content-Type': 'application/json' }}
    );
  }

  try {
    const body = await req.json();
    const { clientReferenceId } = body;
    
    if (!clientReferenceId) {
      console.log('[Verify] Missing client reference ID');
      return new Response(
        JSON.stringify({ isPaid: false, message: 'Client reference ID required' }), 
        { status: 400, headers: { 'Content-Type': 'application/json' }}
      );
    }

    console.log('[Verify] Searching for payment with reference:', clientReferenceId);
    
    // List recent sessions and find the one matching our reference ID
    const sessions = await stripe.checkout.sessions.list({
      limit: 10,
      expand: ['data.payment_intent']
    });

    const matchingSession = sessions.data.find(
      session => session.client_reference_id === clientReferenceId
    );

    if (!matchingSession) {
      console.log('[Verify] No matching session found');
      return new Response(
        JSON.stringify({ isPaid: false, message: 'Payment not found' }), 
        { status: 404, headers: { 'Content-Type': 'application/json' }}
      );
    }

    console.log('[Verify] Found matching session:', {
      id: matchingSession.id,
      payment_status: matchingSession.payment_status,
      client_reference_id: matchingSession.client_reference_id
    });

    return new Response(
      JSON.stringify({ 
        isPaid: matchingSession.payment_status === 'paid',
        sessionId: matchingSession.id
      }), 
      { status: 200, headers: { 'Content-Type': 'application/json' }}
    );

  } catch (error) {
    console.error('[Verify] Error:', error);
    return new Response(
      JSON.stringify({ isPaid: false, message: 'Internal server error' }), 
      { status: 500, headers: { 'Content-Type': 'application/json' }}
    );
  }
}
