document.addEventListener('DOMContentLoaded', function() {
    const projectHero = document.querySelector('.project-hero');
    const projectCards = document.querySelectorAll('.project-card');
    
    // Handle hero card click
    if (projectHero) {
        projectHero.addEventListener('click', function(e) {
            if (e.target.tagName !== 'A') {
                const url = this.getAttribute('data-url');
                if (url) {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        window.open(url, '_blank');
                    } else {
                        window.location.href = url;
                    }
                }
            }
        });
    }
    
    // Handle grid card clicks
    projectCards.forEach(card => {
        card.addEventListener('click', function(e) {
            if (e.target.tagName !== 'A') {
                const url = this.getAttribute('data-url');
                if (url) {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        window.open(url, '_blank');
                    } else {
                        window.location.href = url;
                    }
                }
            }
        });
    });
});
