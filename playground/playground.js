document.addEventListener('DOMContentLoaded', function() {
    const toyHero = document.querySelector('.toy-hero');
    const toyCards = document.querySelectorAll('.toy-card');
    
    // Handle hero card click
    if (toyHero) {
        toyHero.addEventListener('click', function(e) {
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
    toyCards.forEach(card => {
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
