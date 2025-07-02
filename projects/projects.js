document.addEventListener('DOMContentLoaded', function() {
    // Select all elements with the class 'projects'
    const projects = document.querySelectorAll('.projects');

    // Iterate over each project element
    projects.forEach(project => {
        // Add a click event listener to each project
        project.addEventListener('click', () => {
            // Retrieve the URL from the 'data-url' attribute
            const url = project.getAttribute('data-url');
            
            // Check if the URL exists
            if (url) {
                // Check if the URL is an external link
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    // Open external links in a new tab
                    window.open(url, '_blank');
                } else {
                    // Navigate to internal links in the current tab
                    window.location.href = url;
                }
            }
        });
    });
});
