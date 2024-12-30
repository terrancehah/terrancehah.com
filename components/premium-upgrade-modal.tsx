import { useState, useEffect } from 'react'
import { X, MapPin, Star, Calendar, Coffee, Headphones, Zap } from 'lucide-react'
import { cn } from '../utils/cn'

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

export default function PremiumUpgradeModal({ isOpen, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  useEffect(() => {
    // Clean up any existing button
    const container = document.getElementById('stripe-button-container')
    if (container) {
      container.innerHTML = ''
    }

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
    
    // Wait for container and mount
    const interval = setInterval(() => {
      const container = document.getElementById('stripe-button-container')
      if (container) {
        container.appendChild(stripeButton)
        clearInterval(interval)

        // Add custom styles to the button
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
      }
    }, 100)

    return () => {
      clearInterval(interval)
      // Clean up script on unmount
      const script = document.querySelector('script[src="https://js.stripe.com/v3/buy-button.js"]')
      if (script) {
        script.remove()
      }
    }
  }, [])

  return (
    <div className="absolute inset-0 bottom-[64px] bg-white/95 backdrop-blur-sm z-[60]">
      <div className="h-full w-full overflow-auto">
        <div className="relative w-full max-w-2xl mx-auto font-raleway p-6">
          <button
            onClick={onClose}
            className="absolute top-2 right-2 text-gray-600 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 p-1.5 rounded-2xl transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-primary mb-4">Unlock Unlimited Travel Planning</h2>
              <div className="flex items-center justify-center gap-2 text-xl">
                <span className="font-bold text-primary">US$1.99</span>
                <span className="text-gray-400 line-through decoration-2">US$4.99</span>
                <span className="bg-blue-100 text-blue-800 text-sm font-medium px-2.5 py-0.5 rounded">Early Adopter Special</span>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <Feature icon={<MapPin />} text="Unlimited places" />
              <Feature icon={<Star />} text="Personalized recommendations" />
              <Feature icon={<Calendar />} text="Advanced planning" />
              <Feature icon={<Coffee />} text="Local insider tips" />
              <Feature icon={<Headphones />} text="Priority support" />
              <Feature icon={<Zap />} text="No ads" />
            </div>

            <div className="w-min bg-white mx-auto rounded-2xl px-4 py-3 shadow-lg border border-gray-100">
              <div id="stripe-button-container" className="flex justify-center"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="bg-light-blue bg-opacity-40 rounded-lg p-3 hover:bg-opacity-60 transition-all duration-200">
      <div className="flex items-center space-x-3">
        <div className="text-sky-blue p-2 bg-white rounded-md shadow-sm">{icon}</div>
        <span className="text-primary text-sm font-medium">{text}</span>
      </div>
    </div>
  )
}
