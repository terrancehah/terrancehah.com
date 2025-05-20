// Make entire articles container clickable
document.addEventListener('DOMContentLoaded', function() {
    const articles = document.querySelectorAll('.articles');
    articles.forEach(article => {
        article.addEventListener('click', function(e) {
            // Prevent navigation if clicking on the actual link inside
            if (e.target.tagName !== 'A') {
                const url = this.getAttribute('data-url');
                if (url) {
                    window.location.href = url;
                }
            }
        });
    });
});
