import Link from "next/link"
import { Plane, Twitter, Facebook, Instagram } from "lucide-react"
import Image from "next/image"

export default function Footer() {
  return (
    <footer className="w-full py-6 bg-light-blue flex items-center">
      <div className="container w-[80%] md:w-full mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mx-auto">

          <div className="flex flex-col space-y-4">
            <Link href="/" className="flex items-center space-x-2">
              <Image
              src="/images/travel-rizz.png"
              alt="Travel-Rizz Logo"
              width={40}
              height={40}
              className="h-10 w-10 object-contain"
            />
              <span className="font-bold text-primary">Travel-Rizz</span>
            </Link>
            <p className="text-sm text-secondary">Plan Your Dream Trip Effortlessly.</p>
          </div>

          <div className="mt-2">
            <h3 className="font-semibold mb-4 text-primary">Quick Links</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="#features" className="text-secondary hover:text-primary">
                  Features
                </Link>
              </li>
              <li>
                <Link href="#about" className="text-secondary hover:text-primary">
                  About Us
                </Link>
              </li>
              <li>
                <Link href="/travel-form" className="text-secondary hover:text-primary">
                  Start Planning
                </Link>
              </li>
            </ul>
          </div>

          <div className="mt-2">
            <h3 className="font-semibold mb-4 text-primary">Legal</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/terms" className="text-secondary hover:text-primary">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="text-secondary hover:text-primary">
                  Privacy Policy
                </Link>
              </li>
            </ul>
          </div>

          <div className="mt-2">
            <h3 className="font-semibold mb-4 text-primary">Follow Us</h3>
            <div className="flex space-x-4">
              <Link href="https://x.com/travelrizz" target="_blank" aria-label="Twitter" className="text-secondary hover:text-primary">
                <Twitter className="h-5 w-5" />
              </Link>
              <Link href="https://facebook.com/travelrizz" target="_blank" aria-label="Facebook" className="text-secondary hover:text-primary">
                <Facebook className="h-5 w-5" />
              </Link>
              <Link href="https://instagram.com/travelrizz" target="_blank" aria-label="Instagram" className="text-secondary hover:text-primary">
                <Instagram className="h-5 w-5" />
              </Link>
            </div>
          </div>
        </div>
        <div className="mt-8 pt-8 border-t border-gray-200 flex flex-col-reverse sm:flex-row text-center mx-auto items-center w-full">
          <p className="text-sm text-secondary w-max">© 2025 Travel-Rizz. All rights reserved.</p>
        </div>
      </div>
    </footer>
  )
}
