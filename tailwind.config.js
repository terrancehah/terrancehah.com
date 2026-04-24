/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './*.html',
    './articles/**/*.html',
    './playground/**/*.html',
    './projects/**/*.html',
    './*.{js,jsx,ts,tsx}', // Scan JS, JSX, TS, TSX files in the root directory
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
        // Legacy site-wide colors (kept for backward compatibility)
        'primary': '#123456',
        'secondary': '#456789',
        'sky-blue': '#4a88c6',
        'light-blue': '#e8f4ff',

        // Nature palette - green tones used on homepage nature section & chapter cards
        // Scale from lightest (50) to deepest (900)
        nature: {
          50:  '#f7fff9', // very light near-white green — chapter-text
          100: '#eff8f1', // lighter green — chapter-title
          200: '#e2fbe8', // pale green — article-link background
          300: '#d4edda', // light tint — nature section bg, homepage header
          400: '#a9d3af', // mid-light (interpolated) — future use
          500: '#447f46', // medium green — chapter card background
          600: '#3f7b4f', // medium dark — accents/buttons
          700: '#295234', // deep green — alt card bg
          800: '#234a2d', // darker (interpolated) — future use
          900: '#1e4620', // deepest green — nature section text
        },

        // Tech palette - navy & blue tones used on homepage tech section & chapter card
        // Scale from lightest (50) to deepest (900)
        tech: {
          50:  '#f0f6fb', // near-white blue — future hover states
          100: '#E5F1F9', // very light blue — chapter-title
          200: '#cfe2f3', // light tint — tech section bg, homepage footer
          300: '#b8d4e6', // softer blue (legacy)
          400: '#8fb3d9', // muted accent — chapter-label
          500: '#457B9D', // steel blue — existing site accent
          600: '#3d6b8a', // deeper steel (interpolated)
          700: '#1d3557', // dark navy — existing site primary
          800: '#142a47', // very dark (interpolated)
          900: '#0c2340', // deepest navy — tech chapter card bg
        },
      },
      animation: {
        'bounce': 'bounce 2s infinite',
        'gradient-x': 'gradient-x 2s ease-in-out infinite',
        'modal-appear': 'modal-appear 0.3s ease-out',
        'slide-up': 'slide-up 0.3s ease-out'
      },
      keyframes: {
        bounce: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-20px)' },
        },
        'gradient-x': {
          '0%': { 'background-position': '0% 50%' },
          '50%': { 'background-position': '100% 50%' },
          '100%': { 'background-position': '0% 50%' }
        },
        'modal-appear': {
          '0%': { opacity: '0', transform: 'scale(0.9)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' }
        }
      },
      spacing: {
        '14': '3.5rem',
      },
      height: {
        '500': '500px',
        '600': '600px',
        '700': '700px',
      }
    },
  },
  plugins: [],
}