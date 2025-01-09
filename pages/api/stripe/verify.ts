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
  
  if (req.method !== 'GET') {
    console.log('[Verify] Invalid method:', req.method);
    return new Response(
      JSON.stringify({ verified: false, message: 'Method not allowed' }), 
      { status: 405, headers: { 'Content-Type': 'application/json' }}
    );
  }

  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id');
  const referenceId = searchParams.get('reference_id');
  console.log('[Verify] Session ID:', sessionId);
  console.log('[Verify] Reference ID:', referenceId);

  if (!sessionId || !referenceId) {
    console.log('[Verify] Missing required parameters');
    return new Response(
      JSON.stringify({ verified: false, message: 'Session ID and Reference ID required' }), 
      { status: 400, headers: { 'Content-Type': 'application/json' }}
    );
  }

  try {
    console.log('[Verify] Retrieving session from Stripe');
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log('[Verify] Session retrieved:', {
      payment_status: session.payment_status,
      client_reference_id: session.client_reference_id,
      expected_reference_id: referenceId
    });

    const metadata = await stripe.metadata.list(sessionId);
    console.log('[Verify] Session metadata:', metadata);

    // Verify both payment status and reference ID match
    const isVerified = 
      session.payment_status === 'paid' && 
      session.client_reference_id === referenceId;

    console.log('[Verify] Verification result:', { 
      isVerified,
      payment_status: session.payment_status,
      reference_match: session.client_reference_id === referenceId
    });

    return new Response(
      JSON.stringify({ 
        verified: isVerified,
        client_reference_id: session.client_reference_id 
      }), 
      { status: 200, headers: { 'Content-Type': 'application/json' }}
    );
  } catch (error) {
    console.error('[Verify] Error:', error);
    return new Response(
      JSON.stringify({ verified: false, message: 'Error verifying payment' }), 
      { status: 500, headers: { 'Content-Type': 'application/json' }}
    );
  }
}
