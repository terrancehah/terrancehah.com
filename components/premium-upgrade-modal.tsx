import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '../utils/cn'
import FeatureCarousel from './feature-carousel'

// Declare the custom element for TypeScript
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'stripe-buy-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        'buy-button-id': string;
        'publishable-key': string;
      }
    }
  }
}

export default function PremiumUpgradeModal({ isOpen = false, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const [isMobile, setIsMobile] = useState(false)
  const stripeContainerRef = useRef<HTMLDivElement>(null)

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

    // Add the script if it doesn't exist
    if (!document.querySelector('script[src="https://js.stripe.com/v3/buy-button.js"]')) {
      const script = document.createElement('script')
      script.src = 'https://js.stripe.com/v3/buy-button.js'
      script.async = true
      document.body.appendChild(script)
    }

    // Create and mount the button
    const stripeButton = document.createElement('stripe-buy-button')
    stripeButton.setAttribute('buy-button-id', 'buy_btn_1QbgllI41yHwVfoxHUfAJEEx')
    stripeButton.setAttribute('publishable-key', 'pk_live_51MtLXgI41yHwVfoxoenCC4Y3iWAv4dwTMPFtBsuAWnJItf6KjcLgtClHE281ixQp5j7tQdmHt9JCtyVSvGaVOI4N00AXx9Bg3a')
    
    // Mount button immediately
    stripeContainerRef.current.appendChild(stripeButton)

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
  }, [isOpen]) // Re-run when isOpen changes

  return isOpen ? (
    <div className="absolute inset-0 bottom-[64px] bg-light-blue/85 backdrop-blur-sm z-[60]">
      <div className="h-full w-full overflow-auto">
        <div className="relative w-full max-w-2xl mx-auto font-raleway py-4 px-2">
          <button
            onClick={onClose}
            className="absolute top-6 right-2 text-gray-600 hover:text-gray-800 bg-slate-300 hover:bg-slate-400 p-1.5 rounded-2xl transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="space-y-2">
            <div className="text-center">
              {/* <h1 className="font-caveat font-bold text-5xl leading-tight text-primary mb-1">Travel Rizz</h1> */}
              <h2 className=" w-[70%] mx-auto text-2xl font-bold text-primary mb-2">The prompt limit for free usage has been reached. Now with an one-time payment, you can unlock unlimited travel planning!</h2>
              <div className="flex flex-wrap items-center justify-center gap-1 text-xl">
                <span className="font-bold text-2xl text-center order-1 basis-1/5 text-primary">US$1.99</span>
                <span className="text-gray-400 text-center text-2xl order-1 basis-1/5 line-through decoration-2">US$4.99</span>
                <span className="bg-blue-200 text-blue-500 text-sm font-medium px-2.5 py-1 order-2 basis-[30%] rounded">Early Adopter Special</span>
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
  ) : null
}
