import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Script from 'next/script';
import flatpickr from 'flatpickr';
import Link from 'next/link';
import { useBackgroundVideo } from '../hooks/useBackgroundVideo';
import LoadingSpinner from '../components/LoadingSpinner';
import PopupWindow from '../components/modals/PopupWindow';
import styles from '../styles/TravelForm.module.css';
import { TravelPreference, TravelSession } from '../managers/types';
import { initializeSession, SESSION_CONFIG, generateSessionId, safeStorageOp, getStoredSession } from '../utils/session-manager';

// Add Google Maps types
declare global {
  interface Window {
    google: typeof google;
  }
}

export default function TravelForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const [generatedContent, setGeneratedContent] = useState('');
  const [dateRange, setDateRange] = useState({ startDate: '', endDate: '' });
  const destinationRef = useRef<HTMLInputElement>(null);
  const dateRangeRef = useRef<HTMLInputElement>(null);
  const hiddenEndDateRef = useRef<HTMLInputElement>(null);
  const languageRef = useRef<HTMLSelectElement>(null);
  const budgetRef = useRef<HTMLSelectElement>(null);
  const currentVideo = useBackgroundVideo();

  useEffect(() => {
    // Initialize flatpickr
    if (dateRangeRef.current) {
      flatpickr(dateRangeRef.current, {
        mode: 'range',
        dateFormat: 'Y-m-d',
        minDate: 'today',
        onChange: function(selectedDates) {
          if (selectedDates.length === 2) {
            // Format dates in local time to preserve the selected dates
            const startDate = selectedDates[0].getFullYear() + '-' + 
              String(selectedDates[0].getMonth() + 1).padStart(2, '0') + '-' + 
              String(selectedDates[0].getDate()).padStart(2, '0');
            const endDate = selectedDates[1].getFullYear() + '-' + 
              String(selectedDates[1].getMonth() + 1).padStart(2, '0') + '-' + 
              String(selectedDates[1].getDate()).padStart(2, '0');
            
            console.log('Selected dates:', { startDate, endDate, raw: selectedDates.map(d => d.toString()) });
            setDateRange({ startDate, endDate });
            if (hiddenEndDateRef.current) {
              hiddenEndDateRef.current.value = endDate;
            }
          }
        }
      });
    }

    // Initialize Google Places Autocomplete
    if (window.google && destinationRef.current) {
      const autocomplete = new google.maps.places.Autocomplete(destinationRef.current, {
        types: ['(cities)']
      });
      
      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (destinationRef.current && place.formatted_address) {
          destinationRef.current.value = place.formatted_address;
        }
      });
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    // Get form values
    const city = destinationRef.current?.value || '';
    const formattedStartDate = dateRange.startDate;
    const formattedEndDate = dateRange.endDate;
    
    // Get language and budget from refs
    const language = languageRef.current?.value;
    const budget = budgetRef.current?.value;
    
    console.log('Form Values:', {
      city,
      formattedStartDate,
      formattedEndDate,
      language,
      budget
    });
    
    // Get travel preferences and ensure they match the expected format
    const travelPreferences = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="travel-preference"]:checked'))
      .map(checkbox => checkbox.value.trim())  // Just use the raw string value
      .filter(Boolean); // Remove any empty strings

    console.log('Travel Preferences:', travelPreferences);

    if (!city || !formattedStartDate || !formattedEndDate || travelPreferences.length === 0) {
      alert('Please fill in all required fields and select at least one travel preference');
      setLoading(false);
      return;
    }

    try {
      const now = Date.now();
      const sessionId = generateSessionId();
      
      // Create new session with form values
      const session: TravelSession = {
        // Session info
        sessionId,
        startTime: now,
        lastActive: now,
        expiresAt: now + SESSION_CONFIG.ABSOLUTE_TIMEOUT,

        // Travel details
        destination: city,
        startDate: formattedStartDate,
        endDate: formattedEndDate,
        preferences: travelPreferences,
        budget: budget || '',
        language: language || '',
        transport: [],

        // Places
        savedPlaces: [],
        currentStage: 1,

        // Metrics
        totalPrompts: 0,
        stagePrompts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        savedPlacesCount: 0,

        // Payment
        isPaid: false,
        paymentReference: `session_${sessionId}`
      };
      
      // Use session manager's safe storage methods with verification
      console.log('About to store session:', session);
      const storageSuccess = safeStorageOp(() => {
        window.sessionStorage.setItem(SESSION_CONFIG.STORAGE_KEY, JSON.stringify(session));
        // Verify write by reading back immediately
        const written = window.sessionStorage.getItem(SESSION_CONFIG.STORAGE_KEY);
        const parsed = written ? JSON.parse(written) as TravelSession : null;
        console.log('Immediate read-back of session:', parsed);
        if (!parsed || !parsed.destination) {
          console.error('Session write verification failed. Written:', written, 'Parsed:', parsed);
          throw new Error('Session write verification failed');
        }
        return true;
      }, false);

      if (!storageSuccess) {
        console.error('Storage operation failed');
        throw new Error('Failed to save session data');
      }

      // Verify using session manager's methods
      const savedSession = getStoredSession();
      console.log('Final session verification:', savedSession);
      if (!savedSession) {
        console.error('Failed to save session');
        throw new Error('Failed to save session');
      }

      if (!savedSession.destination || !savedSession.startDate || !savedSession.endDate || 
          !savedSession.preferences || !savedSession.preferences.length || 
          !savedSession.sessionId || !savedSession.startTime || 
          !savedSession.lastActive || !savedSession.expiresAt) {
        console.error('Incomplete session:', savedSession);
        throw new Error('Session data incomplete');
      }

      // Use direct navigation with reload to ensure clean state
      window.location.href = `/?session=${session.sessionId}`;
    } catch (error) {
      console.error('Error:', error);
      alert('An error occurred while processing your request. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const travelPreferences = [
    { value: 'Culture and Heritage', label: "Culture and Heritage 🎏" },
    { value: 'Nature', label: "Nature 🍀" },
    { value: 'Foodie', label: "Foodie 🍱" },
    { value: 'Leisure', label: "Leisure 🌇" },
    { value: 'Adventure', label: "Adventure 🪂" },
    { value: 'Arts & Museum', label: "Arts & Museum 🎨" }
  ];

  return (
    <>
      <Head>
        <title>Travel-Rizz - Your Travel Assistant</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="https://use.fontawesome.com/releases/v5.3.1/css/all.css" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css" />
        <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
      </Head>

      <Script
        src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`}
        strategy="beforeInteractive"
      />
      
      {loading && <LoadingSpinner />}
      
      <PopupWindow
        isOpen={isPopupOpen}
        onClose={() => setIsPopupOpen(false)}
        content={generatedContent}
      />

      <div className="min-h-screen flex flex-col bg-gray-100">
        <header className="w-full inline-block relative z-50 bg-white backdrop-blur-sm">
          <div className="flex flex-col md:flex-row justify-between items-center p-2.5 sm:p-3">
            {/* Left: Title */}
            <div className="flex flex-col md:flex-row items-center w-auto md:w-56 gap-1">
              <h1 className="block font-lato font-semibold text-[#1234576] text-2xl md:text-3xl p-0 text-center sm:w-auto">
                Travel-Rizz
              </h1>
            </div>

            {/* Middle: Nav buttons */}
            <nav className="flex flex-wrap justify-center gap-3">
              <Link href="/" className="relative p-2 font-raleway font-medium text-lg md:text-xl text-sky-blue hover:bg-light-blue transition duration-300">Home</Link>
              <Link href="/articles" className="relative p-2 font-raleway font-medium text-lg md:text-xl text-sky-blue hover:bg-light-blue transition duration-300">Articles</Link>
              <Link href="/projects" className="relative p-2 font-raleway font-medium text-lg md:text-xl text-sky-blue hover:bg-light-blue transition duration-300">Projects</Link>
              <Link href="/playground" className="relative p-2 font-raleway font-medium text-lg md:text-xl text-sky-blue hover:bg-light-blue transition duration-300">Playground</Link>
            </nav>

            {/* Right side: Social Icons */}
            <div className="flex items-center gap-4 mt-2 md:mt-0">
              <a href="https://facebook.com/terrancehah/" target="_blank" className="w-8 h-8">
                <img src="/icons/facebook.png" alt="facebook" className="w-full h-full" />
              </a>
              <a href="https://instagram.com/terrancehah/" target="_blank" className="w-8 h-8">
                <img src="/icons/instagram.png" alt="instagram" className="w-full h-full" />
              </a>
              <a href="https://x.com/terrance_hah" target="_blank" className="w-8 h-8">
                <img src="/icons/x.png" alt="x" className="w-full h-full" />
              </a>
              <a href="https://linkedin.com/terrancehah/" target="_blank" className="w-8 h-8">
                <img src="/icons/linkedin.png" alt="linkedin" className="w-full h-full" />
              </a>
              <a href="https://github.com/terrancehah" target="_blank" className="w-8 h-8">
                <img src="/icons/github.png" alt="github" className="w-full h-full" />
              </a>
            </div>
          </div>
        </header>

        <main className="relative flex flex-grow z-10">
            <video 
              key={currentVideo}
              id="backgroundVideo" 
              className="opacity-35 object-cover w-full h-full absolute"
              autoPlay 
              muted 
              loop
              playsInline
              onError={(e) => {
                console.error('Video error:', e);
              }}
            >
              <source src={currentVideo} type="video/mp4" />
              Your browser does not support the video tag.
            </video>

          <form id="trip-form" onSubmit={handleSubmit} className="flex flex-col w-full h-full my-auto mx-auto justify-center items-center">
            {/* Title and subtitle */}
            <div className="relative space-y-2 p-3 text-center w-90% lg:w-4/5 md:w-4/5 mx-auto z-2">
              <div>
                <h1 className={styles.title}>
                  Welcome to Travel-Rizz:
                  <br />Your Personalized Journey Awaits
                </h1>
              </div>
              <div>
                <h3 className={styles.subtitle}>
                  Discover the joy of seamless travel planning with Travel-Rizz, your convenient travel assistant.
                </h3>
              </div>
            </div>

            {/* Destination, Calendar and filters */}
            <div className="flex flex-wrap w-[90%] lg:min-w-[930px] 2xl:w-[60%] relative bg-white mx-2 my-2 justify-center p-0 rounded-3xl items-center h-min shadow-all group/mainContainer">
              
              {/* Destination div */}
              <div className="destination-input-form flex flex-col px-10 py-5 w-full lg:basis-1/2 rounded-t-3xl md:rounded-tr-none z-10 focus-within:z-20 order-1 group-active/mainContainer:[&:not(:active)]:bg-slate-200 group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 focus-within:bg-white focus-within:hover:bg-white focus-within:shadow-all has-[:focus]:shadow-all has-[:active]:shadow-all focus-within:shadow-all hover:bg-slate-200">
                <label className="text-lg font-raleway font-semibold text-gray-700 text-left w-80 sm:w-80 md:w-[60%] lg:w-[50%] xl:w-96 px-0 py-0">
                  Destination
                </label>
                <input
                  type="search"
                  id="destination"
                  name="destination"
                  ref={destinationRef}
                  placeholder=" Search your destination here"
                  autoComplete="off"
                  className="w-full xl:w-96 relative cursor-text text-md px-2 py-1 bg-inherit rounded-md text-gray-700 focus:border-light-blue-500 font-normal font-raleway"
                />
              </div>

              {/* Horizontal Separator after Destination */}
              <div className="h-[1px] w-[100%] my-0 border-0 order-2 lg:order-2 basis-[100%] lg:hidden
                group-active/mainContainer:[&:not(:active)]:bg-slate-200 
                group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 
                hover:bg-slate-200 flex items-center justify-center">
                <div className="h-[1px] w-[90%] md:w-[90%] bg-gray-300"></div>
              </div>

              {/* Date Input */}
              <div className="flex flex-col w-full lg:basis-1/2 mx-0 py-5 px-10 relative order-3 justify-center md:rounded-tr-3xl focus-within:z-20 z-10 focus-within:shadow-all group-active/mainContainer:[&:not(:active)]:bg-slate-200 group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 hover:bg-slate-200 focus-within:hover:bg-white focus-within:bg-white">
                <label className="text-lg font-raleway font-semibold text-gray-700 text-left w-full">
                  Dates
                </label>
                <input
                  type="text"
                  id="start-date"
                  name="start-date"
                  ref={dateRangeRef}
                  placeholder=" Select dates here"
                  className="w-full relative cursor-pointer text-md px-0 py-1 bg-inherit rounded-md text-gray-700 font-normal font-raleway"
                  required
                />
                <input
                  type="hidden"
                  id="hidden-end-date"
                  name="hidden-end-date"
                  ref={hiddenEndDateRef}
                />
              </div>

              {/* Horizontal Separator after DateInput */}
              <div className="h-[1px] w-[100%] my-0 border-0 order-4 md:order-4 basis-[100%]
                group-active/mainContainer:[&:not(:active)]:bg-slate-200 
                group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 
                hover:bg-slate-200 flex items-center justify-center">
                <div className="h-[1px] w-[90%] md:w-[90%] bg-gray-300"></div>
              </div>

              {/* Travel Preferences */}
              <div className="flex flex-col w-full my-0 mx-0 px-10 py-4 pb-6 focus-within:z-20 order-5 focus-within:shadow-all active:shadow-all has-[:focus]:shadow-all has-[:active]:shadow-all focus-within:bg-white hover:focus-within:bg-white focus-within:shadow-all has-[:focus]:shadow-all has-[:active]:shadow-all focus-within:shadow-all hover:bg-slate-200 md:rounded-bl-3xl">
                <label className="text-lg font-raleway font-semibold text-gray-700 text-left w-full">
                  Travel Preferences
                </label>
                <p className="text-md font-raleway font-light text-gray-700 mb-2 text-left w-full">
                  You can choose one or more
                </p>
                <div className="flex flex-wrap gap-y-3 gap-x-3 justify-start items-start text-left w-full">
                  {travelPreferences.map((pref) => (
                    <label key={pref.value} className="group inline-flex items-center justify-start px-3.5 py-1.5 border border-[#b8b8bb] hover:bg-slate-200 hover:border-secondary hover:border-1 mr-0 ml-0 rounded-md cursor-pointer bg-white bg-opacity-40 shadow-md hover:shadow-lg font-light transition-colors duration-200 [&:has(input:checked)]:bg-[#e9edf0] [&:has(input:checked)]:border-secondary [&:has(input:checked)]:border-1">
                      <input
                        type="checkbox"
                        name="travel-preference"
                        value={pref.value}
                        className="mr-2 peer appearance-none h-5 w-5 border border-[#b8b8bb] focus:border-secondary focus:shadow-sm hover:border-secondary hover:border-5 focus:border-2 rounded bg-white checked:bg-secondary checked:border-transparent cursor-pointer relative checked:after:content-['✓'] checked:after:absolute checked:after:text-white checked:after:text-xs checked:after:top-[1px] checked:after:left-[3px]"
                      />
                      <span className="text-left font-raleway peer-checked:text-secondary peer-checked:font-medium">
                        {pref.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Horizontal Separator after Travel Styles */}
              <div className="h-[1px] w-[100%] my-0 border-0 order-6 basis-[100%]
                group-active/mainContainer:[&:not(:active)]:bg-slate-200 
                group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 
                hover:bg-slate-200 flex items-center justify-center">
                <div className="h-[1px] w-[90%] md:w-[90%] bg-gray-300"></div>
              </div>

              {/* Language Select Section */}
              <div className="flex w-full lg:w-[50%] mx-0 my-0 items-center px-10 pb-0.5 relative  z-10 order-7 
              focus-within:z-20 focus-within:bg-white focus-within:hover:bg-white focus-within:shadow-all has-[:focus]:shadow-all has-[:active]:shadow-all 
              group-active/mainContainer:[&:not(:active)]:bg-slate-200 group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 
              hover:bg-slate-200 md:rounded-bl-3xl">
                <select
                  ref={languageRef}
                  name="language"
                  className="w-full h-12 outline-none relative cursor-pointer text-lg px-0 py-2 pt-1 bg-inherit rounded-md text-gray-700 font-normal font-raleway appearance-none"
                  required
                  defaultValue="select-language"
                >
                  <option value="select-language" disabled>Select Language </option>
                  <option value="English">English</option>
                  <option value="Malay (Bahasa Melayu)">Malay (Bahasa Melayu)</option>
                  <option value="Espanol">Español</option>
                  <option value="Francais">Français</option>
                  <option value="Deutsch">Deutsch</option>
                  <option value="Italiano">Italiano</option>
                  <option value="Czech (Cestina)">Czech (Čeština)</option>
                  <option value="Simplified Chinese (简体中文)">Simplified Chinese (简体中文)</option>
                  <option value="Traditional Chinese (繁體中文)">Traditional Chinese (繁體中文)</option>
                  <option value="Japanese (日本語)">Japanese (日本語)</option>
                  <option value="Korean (한국어)">Korean (한국어)</option>
                </select>
              </div>

              {/* Horizontal Separator after Languages Selection */}
              <div className="h-[1px] w-[100%] my-0 border-0 lg:hidden order-8
                group-active/mainContainer:[&:not(:active)]:bg-slate-200 
                group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 
                hover:bg-slate-200 flex items-center justify-center">
                <div className="h-[1px] w-[90%] md:w-[90%] bg-gray-300"></div>
              </div>

              {/* Budget Select Section */}
              <div className="flex flex-col w-full lg:w-[50%] mx-0 my-0 items-center px-10 pb-0.5 relative focus-within:z-20 z-10 order-9 
              focus-within:bg-white focus-within:hover:bg-white focus-within:shadow-all has-[:focus]:shadow-all has-[:active]:shadow-all 
              group-active/mainContainer:[&:not(:active)]:bg-slate-200 group-focus-within/mainContainer:[&:not(:focus-within)]:bg-slate-200 
              hover:bg-slate-200 md:rounded-br-3xl">
                <select
                  ref={budgetRef}
                  name="budget"
                  className="w-full h-12 outline-none relative cursor-pointer text-lg px-0 py-2 pt-1 bg-inherit rounded-md text-gray-700 font-normal font-raleway appearance-none"
                  required
                  defaultValue="select-budget"
                >
                  <option value="select-budget" disabled>Select Budget </option>
                  <option value="$">Budget ($)</option>
                  <option value="$$">Moderate ($$)</option>
                  <option value="$$$">Luxury ($$$)</option>
                  <option value="$$$$">Ultra Luxury ($$$$)</option>
                </select>
              </div>
            </div>

            {/* Submit button */}
            <div className="w-[90%] md:w-[66%] lg:w-[40%] xl:w-[33%] rounded-3xl mx-auto my-4 text-center">
              <button
                id="generate-button"
                type="submit"
                disabled={loading}
                className="w-[200px] h-12 rounded-2xl bg-white text-sky-blue font-raleway font-semibold text-lg shadow-lg hover:bg-white hover:text-secondary hover:shadow-lg hover:shadow-slate-500 transition-all duration-300 ease-in-out hover:-translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Processing...' : 'Take Me There'}
              </button>
            </div>
          </form>
        </main>
      </div>
    </>
  );
}
