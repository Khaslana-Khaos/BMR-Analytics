/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        slateglass: {
          900: '#0f172a',
          800: '#1f2937',
          700: '#334155',
          600: '#475569'
        }
      }
    }
  },
  plugins: []
};
