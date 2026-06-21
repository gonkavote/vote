/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#06060b',
        'bg-2': '#0e0e16',
        'bg-card': '#141420',
        text: '#f0f0f5',
        'text-2': '#8a8aa0',
        accent: '#3b82f6',
        'accent-2': '#818cf8',
        'accent-3': '#c084fc',
        border: 'rgba(255,255,255,0.06)',
      },
      borderRadius: {
        card: '16px',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      backgroundImage: {
        'grad-text': 'linear-gradient(135deg, #3b82f6 0%, #818cf8 50%, #c084fc 100%)',
        'grad-glow': 'radial-gradient(ellipse, rgba(59,130,246,0.15) 0%, transparent 70%)',
      },
      boxShadow: {
        glow: '0 0 28px 4px rgba(59,130,246,0.45)',
        card: '0 8px 30px rgba(0,0,0,0.25)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
