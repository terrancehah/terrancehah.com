import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '../utils/cn'
import FeatureCarousel from './feature-carousel'

import { 
  setPaymentStatus, 
  setPaymentReference,
  getPaymentReference,
  clearPaymentReference 
} from '../utils/session-manager'

// Declare the custom element for TypeScript
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'stripe-buy-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        'buy-button-id': string;
        'publishable-key': string;
        'client-reference-id': string;
      }
    }
  }
}

export default function PremiumUpgradeModal({ 
  isOpen = false, 
  onClose,
  onPaymentSuccess 
}: { 
  isOpen?: boolean; 
  onClose?: () => void;
  onPaymentSuccess?: () => void;
}) {
  const [isMobile, setIsMobile] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [isPolling, setIsPolling] = useState(false)
  const stripeContainerRef = useRef<HTMLDivElement>(null)
  const clientReferenceId = useRef<string>('')
  const pollIntervalRef = useRef<NodeJS.Timeout>()

  // Generate client reference ID on mount
  useEffect(() => {
    if (!clientReferenceId.current) {
      // Check if we have a stored reference ID first
      const storedRefId = getPaymentReference();
      if (storedRefId) {
        clientReferenceId.current = storedRefId;
      } else {
        // Generate a new one ONLY if we don't have one
        clientReferenceId.current = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Store the new reference ID
        setPaymentReference(clientReferenceId.current);
      }
      console.log('[Payment] Using client reference ID:', clientReferenceId.current);
    }
  }, [])

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  useEffect(() => {
    if (!isOpen || !stripeContainerRef.current) return

    // Clean up any existing button
    stripeContainerRef.current.innerHTML = ''

    // Get the reference ID from our ref (NOT from storage again)
    const refId = clientReferenceId.current;
    if (!refId) {
      console.error('[Payment] No payment reference found in ref');
      return;
    }

    console.log('[Payment] Setting up button with reference ID:', refId);

    // Create the button HTML directly
    const buttonHtml = `
      <stripe-buy-button
        buy-button-id="buy_btn_1QfJT2I41yHwVfoxrEmjHuCU"
        publishable-key="pk_test_51MtLXgI41yHwVfoxNp7MKLfz0Gh4qo2LwImaCBtCt0Gn48e613BLsbOajpHT1uJOs2l0ACRpUE3RZrh8FcLxdwef00QOtxcHmf"
        client-reference-id="${refId}"
      >
      </stripe-buy-button>
    `;

    stripeContainerRef.current.innerHTML = buttonHtml;

    // Load Stripe script dynamically
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/buy-button.js';
    script.async = true;
    document.head.appendChild(script);

    // Add custom styles
    const style = document.createElement('style')
    style.textContent = `
      stripe-buy-button {
        display: flex !important;
        justify-content: center !important;
        width: 40% !important;
        margin: 0 auto !important;
      }
      stripe-buy-button > * {
        border: 2px solid #e2e8f0 !important;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06) !important;
        border-radius: 0.5rem !important;
        width: 100% !important;
      }
      stripe-buy-button button {
        width: 100% !important;
      }
    `
    document.head.appendChild(style)

    return () => {
      // Clean up styles
      document.head.removeChild(style)
    }
  }, [isOpen])

  // Start polling when modal opens and Stripe script is loaded
  useEffect(() => {
    if (!isOpen) return;

    // Wait for Stripe script to load
    const waitForStripe = setInterval(() => {
      const stripeButton = document.querySelector('stripe-buy-button');
      if (stripeButton) {
        console.log('[Payment Modal] Stripe button loaded, starting polling...');
        setIsPolling(true);
        clearInterval(waitForStripe);
      }
    }, 500);

    return () => {
      clearInterval(waitForStripe);
    };
  }, [isOpen]);

  // Payment polling effect
  useEffect(() => {
    const pollPaymentStatus = async () => {
      const refId = clientReferenceId.current;
      if (!refId) {
        console.log('[Payment Modal] No reference ID found, stopping poll');
        setIsPolling(false);
        return false;
      }

      console.log('[Payment Modal] Polling payment status for:', refId);
      try {
        const response = await fetch(`${window.location.origin}/api/stripe/verify`, {  
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json'},
          body: JSON.stringify({ clientReferenceId: refId })
        });

        if (!response.ok) {
          console.log('[Payment Modal] Verify request failed:', response.status);
           // Log more details about the error
          const text = await response.text();
          console.log('[Payment Modal] Error details:', {
            status: response.status,
            statusText: response.statusText,
            body: text,
            headers: Object.fromEntries(response.headers.entries())
          });
          return false;
        }

        const data = await response.json();
        console.log('[Payment Modal] Verification response:', data);

        if (data.isPaid) {
          console.log('[Payment Modal] Payment verified for reference:', refId);
          
          // First update the payment status in storage
          setPaymentStatus(true);
          console.log('[Payment Modal] Payment status updated in storage');
          
          // Then update UI states
          setShowSuccess(true);
          clearPaymentReference();
          console.log('[Payment Modal] UI states updated');
          
          // Notify parent component of success
          if (onPaymentSuccess) {
            onPaymentSuccess();  // Parent only needs to handle high-level success state
            console.log('[Payment Modal] Parent notified of success');
          }
          
          // Close the modal last
          if (onClose) {
            onClose();
            console.log('[Payment Modal] Modal closed');
          }
          
          return true;
        } else if (data.pendingVerification) {
          console.log('[Payment Modal] Payment pending webhook verification, continuing to poll');
          return false;
        }
      } catch (error) {
        console.error('[Payment Modal] Error polling payment status:', error);
        // If it's a network error, log more details
        if (error instanceof TypeError) {
          console.log('[Payment Modal] Network error details:', {
            message: error.message,
            stack: error.stack
          });
        }
      }
      return false;
    };

    // Start/stop polling based on isPolling state
    if (isPolling) {
      console.log('[Payment Modal] Starting payment polling interval');
      pollIntervalRef.current = setInterval(async () => {
        console.log('[Payment Modal] Polling iteration starting');
        const success = await pollPaymentStatus();
        if (success) {
          console.log('[Payment Modal] Polling succeeded, cleaning up');
          setIsPolling(false);
        }
      }, 2000);
    }

    // Cleanup
    return () => {
      if (pollIntervalRef.current) {
        console.log('[Payment Modal] Cleaning up polling interval');
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = undefined;
      }
    };
  }, [isPolling, onClose, onPaymentSuccess]);

  return (
    <>
      {isOpen ? (
        <div className="absolute inset-0 bottom-[64px]  bg-white/85 backdrop-blur-sm z-[60]">
          <div className="h-full w-full overflow-hidden">
            <div className="flex h-full m-auto font-raleway py-4 px-2">
              <button
                onClick={onClose}
                className="absolute top-6 right-6 text-gray-600 hover:text-gray-800 bg-slate-300 hover:bg-slate-400 p-1.5 rounded-2xl transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex flex-col items-center justify-center space-y-2 my-auto w-full h-full">
                <div className="text-center">
                  <h2 className=" w-[70%] mx-auto text-lg lg:text-xl font-bold text-primary mb-2">The prompt limit for free usage has been reached. Now with an one-time payment, you can unlock unlimited travel planning!</h2>
                  <div className="flex flex-wrap items-center justify-center gap-1 text-xl">
                    <span className="font-bold text-lg md:text-xl lg:text-2xl text-center order-1 basis-1/5 xl:basis-[15%] text-primary">US$1.99</span>
                    <span className="text-gray-400 text-center text-lg md:text-xl lg:text-2xl order-1 basis-1/5 xl:basis-[15%] line-through decoration-2">US$2.99</span>
                    <span className="bg-blue-200 text-blue-500 text-sm xl:text-base font-medium px-2.5 py-1 order-2 basis-[30%] xl:basis-1/5 rounded">Early Adopter Special</span>
                  </div>
                </div>
                
                <div className="py-2 mt-0">
                  <FeatureCarousel />
                </div>

                <div className="w-min h-min bg-white mx-auto rounded-2xl p-1 shadow-lg border border-gray-100">
                  <div ref={stripeContainerRef} className="flex justify-center"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
