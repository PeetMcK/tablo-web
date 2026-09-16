/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0d0d14",
          raised: "#13131e",
          overlay: "#1a1a28",
          border: "rgba(255,255,255,0.08)",
        },
        accent: {
          // The brand swatch is the highlight; `deep` is the shade the gradient
          // runs down into. Keep these two in step with the .accent-gradient
          // utilities in index.css and the favicon's gradient stops.
          DEFAULT: "#478cc9",
          deep: "#2c6296",
          glow: "rgba(71,140,201,0.25)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
}

