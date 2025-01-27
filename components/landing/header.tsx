import Link from "next/link"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Twitter, Instagram, Facebook,  } from "lucide-react"

export default function Header() {
  return (
    <header className="sticky top-0 z-50 w-full bg-light-blue/95 backdrop-blur supports-[backdrop-filter]:bg-light-blue/60 shadow-sm">
      <div className="flex p-3 px-4 w-full justify-between">
        <Link href="/" className="flex gap-x-1">
          <Image
            src="/images/travel-rizz.png"
            alt="Travel-Rizz Logo"
            width={40}
            height={40}
            className="h-12 w-12 object-contain"
          />
          <span className="font-caveat text-3xl h-min my-auto text-primary">Travel-Rizz</span>
        </Link>
        <div className="flex">
          <div className="hidden md:flex items-center gap-x-4">
            <Link href="https://x.com/travelrizz" target="_blank" className="text-gray-500 hover:text-primary transition-colors">
              <Twitter className="h-6 w-6" />
            </Link>
            <Link href="https://instagram.com/travelrizz" target="_blank" className="text-gray-500 hover:text-primary transition-colors">
              <Instagram className="h-6 w-6" />
            </Link>
            <Link href="https://facebook.com/travelrizz" target="_blank" className="text-gray-500 hover:text-primary transition-colors">
              <Facebook className="h-6 w-6" />
            </Link>
          </div>
          {/* <Button asChild className="bg-sky-blue hover:bg-sky-blue/90">
            <Link href="/plan">Start Planning</Link>
          </Button> */}
        </div>
      </div>
    </header>
  )
}
