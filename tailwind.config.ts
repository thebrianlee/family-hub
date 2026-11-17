import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/app/**/*.{ts,tsx}", "./src/components/**/*.{ts,tsx}", "./src/lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cream: {
          DEFAULT: "#FBF7F1",
          raised: "#FFFDF8",
          sunken: "#F2EBE0",
          line: "#E9E0D2",
        },
        ink: {
          DEFAULT: "#22434E",
          soft: "#5C7078",
          faint: "#98A6AB",
          deep: "#12313B",
        },
        ember: {
          DEFAULT: "#DE7C5A",
          soft: "#F7E2D8",
          deep: "#B85C3E",
        },
        // Member colors are not tokens: see lib/member-theme.ts and globals.css.
        sage: { DEFAULT: "#7FA576", deep: "#4E7448" }, // "done" / "affordable" green
        parent: { DEFAULT: "#5E7B86", soft: "#E4EBED" },
      },
      fontFamily: { sans: ["var(--font-nunito)", "system-ui", "sans-serif"] },
      borderRadius: { tile: "12px", card: "16px", hero: "20px" },
      boxShadow: {
        tile: "0 1px 3px rgba(34, 67, 78, 0.06), 0 2px 10px rgba(34, 67, 78, 0.05)",
        card: "0 2px 6px rgba(34, 67, 78, 0.05), 0 8px 28px rgba(34, 67, 78, 0.07)",
        float: "0 12px 48px rgba(18, 49, 59, 0.18)",
      },
      keyframes: {
        "pop-in": {
          "0%": { transform: "scale(0.7)", opacity: "0" },
          "65%": { transform: "scale(1.05)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "float-up": {
          "0%": { transform: "translateY(0) scale(1)", opacity: "1" },
          "100%": { transform: "translateY(-110px) scale(1.35)", opacity: "0" },
        },
        confetti: {
          "0%": { transform: "translateY(-8vh) rotate(0deg)", opacity: "1" },
          "100%": { transform: "translateY(108vh) rotate(600deg)", opacity: "0.5" },
        },
        shimmer: {
          "0%, 100%": { transform: "translateX(-2%)" },
          "50%": { transform: "translateX(2%)" },
        },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        kenburns: {
          from: { transform: "scale(1) translate(0, 0)" },
          to: { transform: "scale(1.12) translate(-1.5%, -1%)" },
        },
      },
      animation: {
        "pop-in": "pop-in 0.35s cubic-bezier(0.34, 1.4, 0.64, 1) both",
        "float-up": "float-up 1.1s ease-out forwards",
        confetti: "confetti 2.6s linear forwards",
        shimmer: "shimmer 4s ease-in-out infinite",
        "fade-in": "fade-in 0.5s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
