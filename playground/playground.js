document.addEventListener('DOMContentLoaded', function() {
    const toys = document.querySelectorAll('.toys');
    toys.forEach(toy => {
        toy.addEventListener('click', function(e) {
            // Prevent navigation if clicking on an actual link inside the card
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
