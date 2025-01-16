import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { buffer } from 'micro';

// Initialize Stripe with the latest API version
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
});

// Test Stripe connection
const testStripeConnection = async () => {
  try {
    const account = await stripe.accounts.retrieve('self');
    console.log('[Verify] Connected to Stripe account:', {
      id: account.id,
      type: account.type,
      testmode: account.charges_enabled
    });
    return true;
  } catch (error) {
    console.error('[Verify] Failed to connect to Stripe:', error);
    return false;
  }
};

export const config = {
  api: {
    bodyParser: false,
  },
};

// This is the Pages Router API handler
export default async function verify(req: NextApiRequest, res: NextApiResponse) {
  console.log('[Verify] Received verification request');
  
  // Log full request details
  console.log('[Verify] Request details:', {
    method: req.method,
    url: req.url,
    headers: req.headers
  });
  
  // Test endpoint
  if (req.method === 'GET') {
    return res.status(200).json({ message: 'Verify endpoint is working' });
  }
  
  if (req.method !== 'POST') {
    console.log('[Verify] Invalid method:', req.method);
    return res.status(405).json({ isPaid: false, message: 'Method not allowed' });
  }

  try {
    // First verify Stripe connection
    const isConnected = await testStripeConnection();
    if (!isConnected) {
      return res.status(500).json({ 
        isPaid: false, 
        message: 'Could not connect to Stripe. Please check your API key.' 
      });
    }

    // Parse raw body since bodyParser is false
    const rawBody = await buffer(req);
    const body = JSON.parse(rawBody.toString());
    const { sessionId, clientReferenceId } = body;
    
    console.log('[Verify] Request body:', body);
    
    if (!sessionId && !clientReferenceId) {
      console.log('[Verify] Missing session ID or client reference ID');
      return res.status(400).json({ isPaid: false, message: 'Either sessionId or clientReferenceId is required' });
    }

    let session: Stripe.Checkout.Session;

    if (sessionId) {
      console.log('[Verify] Looking up session:', sessionId);
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } else {
      console.log('[Verify] Looking up session by client reference:', clientReferenceId);
      const sessions = await stripe.checkout.sessions.list({
        limit: 100 // Increase limit to ensure we don't miss recent sessions
      });

      console.log('[Verify] Found sessions:', sessions.data.length);
      
      // Filter after fetching since the API doesn't support filtering by client_reference_id
      const matchingSession = sessions.data.find(
        session => {
          const matches = session.client_reference_id === clientReferenceId;
          console.log('[Verify] Comparing:', {
            sessionRef: session.client_reference_id,
            lookingFor: clientReferenceId,
            matches,
            metadata: session.metadata // Log metadata for debugging
          });
          return matches;
        }
      );

      if (!matchingSession) {
        console.log('[Verify] No matching session found');
        return res.status(404).json({ error: 'No session found for reference ID' });
      }
      
      // Get the full session with metadata
      session = await stripe.checkout.sessions.retrieve(matchingSession.id);
    }

    console.log('[Verify] Found session:', {
      id: session.id,
      payment_status: session.payment_status,
      client_reference_id: session.client_reference_id,
      metadata: session.metadata
    });

    // Check both payment_status and webhook verification metadata
    const paymentStatusCheck = session.payment_status === 'paid';
    const webhookVerifiedCheck = session.metadata?.payment_verified === 'true';
    const referenceIdCheck = session.client_reference_id === clientReferenceId;
    
    // Log detailed verification state
    console.log('[Verify] Verification state:', {
      paymentStatus: {
        value: session.payment_status,
        required: 'paid',
        passed: paymentStatusCheck
      },
      webhookVerified: {
        value: session.metadata?.payment_verified,
        required: 'true',
        passed: webhookVerifiedCheck
      },
      referenceId: {
        value: session.client_reference_id,
        required: clientReferenceId,
        passed: referenceIdCheck
      },
      metadata: session.metadata // Log full metadata
    });
    
    const isPaid = paymentStatusCheck && webhookVerifiedCheck && referenceIdCheck;
    
    if (isPaid) {
      console.log('[Verify] Payment verified through webhook and metadata');
    } else {
      console.log('[Verify] Payment verification failed. Conditions:', {
        paymentStatus: {
          required: 'paid',
          received: session.payment_status,
          passed: paymentStatusCheck
        },
        webhookVerified: {
          required: 'true',
          received: session.metadata?.payment_verified,
          passed: webhookVerifiedCheck
        },
        referenceId: {
          required: session.client_reference_id,
          received: session.metadata?.client_reference_id,
          passed: referenceIdCheck
        }
      });
      
      // Return false if any condition fails
      return res.status(200).json({ 
        isPaid: false,
        sessionId: session.id,
        clientReferenceId: session.client_reference_id,
        verifiedAt: null,
        pendingVerification: true
      });
    }

    return res.status(200).json({ 
      isPaid: true,
      sessionId: session.id,
      clientReferenceId: session.client_reference_id,
      verifiedAt: session.metadata?.verified_at
    });
  } catch (error: any) {
    console.error('[Verify] Error:', error);
    return res.status(500).json({ 
      isPaid: false, 
      message: error.message 
    });
  }
}