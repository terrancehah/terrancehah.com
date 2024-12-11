export default function LoadingSpinner() {
  return (
    <div className="fixed inset-0 z-50 flex flex-wrap items-center justify-center bg-black bg-opacity-80">
      <div className="w-[30%] md:w-[20%] mx-auto mb-8">
        <img src="/resources/flyingplane-crop-2.gif" alt="Loading..." className="w-full h-auto animate-bounce" />
      </div>
      <div className="w-full text-center">
        <p className="text-2xl text-white">
          Fasten your seat belt while we are working on your travel itinerary...
        </p>
      </div>
    </div>
  );
}
