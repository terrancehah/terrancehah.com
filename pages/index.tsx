"use client"

import Header from "@/components/landing/header"
import Hero from "@/components/landing/hero"
import About from "@/components/landing/about"
import Features from "@/components/landing/features"
import Footer from "@/components/landing/footer"

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col bg-white">
      <Header />
      <Hero />
      <About />
      <Features />
      <Footer />
    </main>
  )
}
