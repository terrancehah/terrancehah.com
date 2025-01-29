export default function About() {
  return (
    <section id="about" className="w-full py-20 bg-gradient flex items-center">
        <div className="max-w-3xl w-[80%] mx-auto text-center space-y-8">
          <h2 className="font-caveat text-4xl md:text-5xl lg:text-6xl text-primary text-shadow">
            About Travel-Rizz
          </h2>
          <div className="space-y-6 font-raleway text-gray-600 gap-y-4">
            <p className="text-lg md:text-xl leading-relaxed">
            I created Travel-Rizz because I believe everyone deserves to experience the joy of perfectly planned travel, regardless of their planning expertise. 
            Having spent years helping friends and family organize their trips, I noticed how overwhelming the process can be.

            </p>
            <p className="text-lg md:text-xl leading-relaxed">
            Travel shouldn't be stressful - it should be an exciting journey right from the planning stage. 
            That's why I combined the power of AI with my passion for travel to create a tool that makes trip planning as enjoyable as the trip itself.
            </p>
            <p className="text-lg md:text-xl leading-relaxed">
              Whether you're a seasoned traveler or planning your first adventure, Travel-Rizz is here to make your dream trip a reality, one personalized recommendation at a time.
            </p>
          </div>
        </div>
    </section>
  )
}
