import { Button } from "@/components/ui/button"
import Link from "next/link"

export default function Hero() {
  return (
    <section className="w-full py-12 md:py-24 lg:py-32 xl:py-48 bg-light-blue flex items-center">
      <div className="container mx-auto">
        <div className="flex flex-col items-center space-y-4 text-center">
          <div className="space-y-2">
            <h1 className="text-3xl font-semi-bold font-caveat tracking-tighter text-primary sm:text-4xl md:text-5xl lg:text-6xl/none">
              Plan Your Dream Trip with AI
            </h1>
            <p className="mx-auto max-w-[700px] font-raleway text-secondary md:text-xl">
              Experience effortless travel planning with our AI-powered chatbot. Create personalized itineraries
              tailored to your preferences in minutes.
            </p>
          </div>
          <div className="space-x-4">
            <Button asChild size="lg" className="bg-sky-blue text-white hover:bg-sky-blue/90 hover:shadow-md border border-slate-500">
              <Link href="/travel-form">Start Planning</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
