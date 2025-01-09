import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

interface SuccessPopupProps {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
}

export default function SuccessPopup({ isOpen, onClose, title, description }: SuccessPopupProps) {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true)
      // Auto dismiss after 5 seconds
      const timer = setTimeout(() => {
        setIsVisible(false)
        onClose()
      }, 5000)
      return () => clearTimeout(timer)
    }
  }, [isOpen, onClose])

  if (!isVisible) return null

  return (
    <div className="fixed top-4 right-4 z-50 max-w-sm bg-green-50 text-green-900 rounded-lg shadow-lg p-4">
      <button
        onClick={() => {
          setIsVisible(false)
          onClose()
        }}
        className="absolute top-2 right-2 p-1 rounded-full hover:bg-green-100"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="pr-6">
        <h3 className="font-semibold">{title}</h3>
        {description && <p className="mt-1 text-sm opacity-90">{description}</p>}
      </div>
    </div>
  )
}
