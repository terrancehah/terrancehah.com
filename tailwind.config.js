/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './*.{html,js,jsx,ts,tsx}',
    "./styles/**/*.css"
  ],
  theme: {
    extend: {
      fontFamily: {
        raleway: ['Raleway', 'sans-serif'],
        lato: ['Lato', 'sans-serif'],
        caveat: ['Caveat', 'cursive'],
        merriweather: ['Merriweather', 'serif']
      },
      colors: {
        'primary': '#123456',
        'secondary': '#456789',
        'sky-blue': '#4a88c6',
        'light-blue': '#e8f4ff',
      },
      animation: {
        'bounce': 'bounce 2s infinite',
      },
      keyframes: {
        bounce: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-20px)' },
        }
      }
    },
  },
  plugins: [],
}