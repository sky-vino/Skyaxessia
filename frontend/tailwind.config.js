/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0a0c0f",
          1: "#0f1217",
          2: "#141820",
          3: "#1a2030",
          4: "#1e2538"
        },
        accent: {
          DEFAULT: "#0f766e",
          dim: "#0b5f59",
          glow: "rgba(15,118,110,0.15)"
        },
        critical: "#ff4d6d",
        serious: "#ff9f43",
        moderate: "#ffd60a",
        minor: "#0b84a5"
      },
      fontFamily: {
        sans: ["'DM Sans'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
        display: ["'Clash Display'", "'DM Sans'", "sans-serif"]
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-up": "slideUp 0.4s ease-out"
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: { "0%": { opacity: "0", transform: "translateY(12px)" }, "100%": { opacity: "1", transform: "translateY(0)" } }
      }
    }
  },
  plugins: []
};


