import Image from "next/image"

export default function Features() {
  const features = [
    {
      title: "AI Chat Interface",
      description:
        "Engage in natural conversations to customize your travel plans. Our AI understands your preferences and adapts recommendations in real-time.",
      image: "/features/ai-chat.jpg",
    },
    {
      title: "Dynamic Travel Insights",
      description:
        "Get instant access to weather forecasts, currency rates, and local insights as you plan. Make informed decisions with real-time data at your fingertips.",
      image: "/features/insights.jpg",
    },
    {
      title: "Visual Route Planning",
      description:
        "See your daily adventures come to life with interactive maps. Optimize your routes and make the most of every day of your journey.",
      image: "/images/visualised-routes.png",
    },
    {
      title: "Flexible Itinerary Builder",
      description:
        "Easily organize and reorganize your plans with our intuitive drag-and-drop interface. Your perfect itinerary is just a few clicks away.",
      image: "/images/daily-itinerary-planning.png",
    },
  ]

  return (
    <section id="features" className="w-full py-20 flex items-center">
      <div className="container mx-auto">
        <h2 className="text-4xl md:text-5xl font-caveat text-primary text-center mb-16 text-shadow">
          How We Make Travel Planning Effortless
        </h2>
        <div className="space-y-20">
          {features.map((feature, index) => (
            <div
              key={index}
              className={`flex flex-col ${index % 2 === 0 ? "md:flex-row" : "md:flex-row-reverse"} gap-x-12 items-center`}
            >
              <div className="flex-1 space-y-4">
                <h3 className="text-2xl md:text-3xl font-raleway text-primary">{feature.title}</h3>
                <p className="text-gray-600 text-lg font-raleway leading-relaxed">{feature.description}</p>
              </div>
              <div className="flex-1">
                <Image
                  src={feature.image}
                  alt={feature.title}
                  width={600}
                  height={400}
                  className="rounded-lg shadow-lg border border-gray-200"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
