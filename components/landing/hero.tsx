import { Button } from "@/components/ui/button"
import Link from "next/link"

export default function Hero() {
  return (
    <section className="relative w-full py-12 md:py-24 lg:py-32 xl:py-48 flex items-center">
      {/* Background image with overlay */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: 'url("/images/kalbarri-beach.jpeg")',
          opacity: 0.3
        }}
      />
      {/* Content */}
      <div className="relative z-10 flex flex-col w-[80%] mx-auto items-center space-y-4 text-center">
        <div className="space-y-2">
          <h1 className="text-3xl font-semi-bold font-caveat tracking-tighter text-primary sm:text-4xl md:text-5xl lg:text-6xl/none">
            Plan Your Dream Trip Effortlessly
          </h1>
          <p className="mx-auto max-w-[700px] font-raleway text-secondary md:text-xl">
          Let's plan your perfect journey together, combining human expertise with AI assistance to create a personalized trip that's uniquely yours. 
          No more overwhelming planning - just the joy of looking forward to your next adventure.
          </p>
        </div>
        <div className="space-x-4">
          <Button asChild size="lg" className="bg-sky-blue/90 text-white hover:bg-sky-blue hover:shadow-md border border-slate-500">
            <Link href="/travel-form">Let's Plan Together</Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
