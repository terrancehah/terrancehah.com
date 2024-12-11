// Listen to the form submit event
document.getElementById("trip-form").addEventListener("submit", function(e) {
    e.preventDefault();

    // Show loading spinner
    const spinner = document.getElementById("loadingSpinner");
    if (spinner) spinner.style.display = "flex";

    // Get form values
    var city = document.getElementById("destination").value;
    var startDate = document.getElementById("start-date").value.split(" to ")[0];  // Get only the start date
    var endDate = document.getElementById("hidden-end-date").value;
    var language = document.getElementById("language").value;
    var budget = document.getElementById("budget").value;
    var travelPreferences = Array.from(document.querySelectorAll('input[name="travel-preference"]:checked'))
        .map(checkbox => checkbox.value);

    // Debug log
    console.log('Form values:', { city, startDate, endDate, language, budget, travelPreferences });

    // Validate form data
    if (!city || !startDate || !endDate || !language || !budget || travelPreferences.length === 0) {
        if (spinner) spinner.style.display = "none";
        alert('Please fill in all required fields and select at least one travel preference');
        return;
    }

    // Convert language to code format
    const languageMap = {
        'English': 'en',
        'Malay (Bahasa Melayu)': 'ms',
        'Espanol': 'es',
        'Francais': 'fr',
        'Deutsch': 'de',
        'Italiano': 'it',
        'Czech (Cestina)': 'cs',
        'Simplified Chinese (简体中文)': 'zh-CN',
        'Traditional Chinese (繁體中文)': 'zh-TW',
        'Japanese (日本語)': 'ja',
        'Korean (한国어)': 'ko'
    };

    try {
        // Create the URL for the Next.js app
        const nextJsUrl = new URL('http://localhost:3000/');
        
        // Add query parameters
        nextJsUrl.searchParams.set('city', city);
        nextJsUrl.searchParams.set('startDate', startDate);
        nextJsUrl.searchParams.set('endDate', endDate);
        nextJsUrl.searchParams.set('language', languageMap[language] || 'en');
        nextJsUrl.searchParams.set('budget', budget);
        
        // Add travel preferences
        travelPreferences.forEach(pref => {
            nextJsUrl.searchParams.append('travel-preference[]', pref);
        });

        console.log('Redirecting to:', nextJsUrl.toString());

        // Redirect to the Next.js app
        window.location.href = nextJsUrl.toString();
    } catch (error) {
        console.error('Error during form submission:', error);
        if (spinner) spinner.style.display = "none";
        alert('An error occurred while submitting the form. Please try again.');
    }
});