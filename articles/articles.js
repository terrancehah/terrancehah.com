// Make article cards clickable
document.addEventListener('DOMContentLoaded', function() {
    const articleHero = document.querySelector('.article-hero');
    const articleCards = document.querySelectorAll('.article-card');
    
    // Handle hero card click
    if (articleHero) {
        articleHero.addEventListener('click', function(e) {
            if (e.target.tagName !== 'A') {
                const url = this.getAttribute('data-url');
                if (url) {
                    window.location.href = url;
                }
            }
        });
    }
    
    // Handle grid card clicks
    articleCards.forEach(card => {
        card.addEventListener('click', function(e) {
            if (e.target.tagName !== 'A') {
                const url = this.getAttribute('data-url');
                if (url) {
                    window.location.href = url;
                }
            }
        });
    });
});
