/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#0b0f16',
          800: '#121826',
          700: '#1b2333',
          600: '#26304a',
        },
        accent: {
          DEFAULT: '#6ee7b7',
          muted: '#34d399',
        },
        // WhatsApp Web (dark mode) palette.
        wa: {
          bg: '#0b141a', // chat wallpaper base
          panel: '#111b21', // left sidebar / app surface
          header: '#202c33', // top bars + incoming bubbles
          'bubble-in': '#202c33',
          'bubble-out': '#005c4b', // outgoing (sent) bubble
          input: '#2a3942', // text fields
          hover: '#202c33',
          green: '#00a884', // primary accent
          'green-dark': '#008069',
          tick: '#53bdeb', // read receipts
          border: '#222e35',
          primary: '#e9edef', // main text
          secondary: '#8696a0', // muted text / timestamps
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(110,231,183,0.18), 0 12px 40px -16px rgba(110,231,183,0.35)',
      },
      keyframes: {
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'typing-dot': {
          '0%, 60%, 100%': { opacity: '0.35', transform: 'translateY(0)' },
          '30%': { opacity: '1', transform: 'translateY(-3px)' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.2s ease-out both',
        'pop-in': 'pop-in 0.18s ease-out both',
        'typing-dot': 'typing-dot 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
