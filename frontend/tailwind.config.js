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
        /* Accent — Sky pink (was teal). All existing `text-accent` etc get Sky-branded automatically. */
        accent: {
          DEFAULT: "#E00062",
          dim: "#D6008C",
          glow: "rgba(224,0,98,0.15)"
        },
        /* Full Sky palette exposed as Tailwind utilities:
           bg-sky-pink, text-sky-blue, border-sky-purple, etc. */
        sky: {
          orange:  "#FF6B00",
          coral:   "#FF3B7F",
          pink:    "#E00062",
          magenta: "#D6008C",
          purple:  "#A855F7",
          blue:    "#3B82F6",
          "deep-blue": "#1E40AF"
        },
        /* Severity — unchanged */
        critical: "#ff4d6d",
        serious: "#ff9f43",
        moderate: "#ffd60a",
        minor: "#0b84a5"
      },
      fontFamily: {
        /* Sky Text primary, Inter fallback (very close visual match) */
        sans: ["'Sky Text'", "'SkyText'", "'Inter'", "'DM Sans'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
        display: ["'Sky Text'", "'Inter'", "'DM Sans'", "sans-serif"]
      },
      backgroundImage: {
        /* Reusable Sky gradients as Tailwind bg-sky-gradient / bg-sky-warm / bg-sky-cool */
        "sky-gradient": "linear-gradient(100deg, #FF6B00 0%, #FF3B7F 22%, #E00062 45%, #A855F7 72%, #3B82F6 100%)",
        "sky-warm":     "linear-gradient(135deg, #FF6B00 0%, #E00062 100%)",
        "sky-cool":     "linear-gradient(135deg, #E00062 0%, #3B82F6 100%)"
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
