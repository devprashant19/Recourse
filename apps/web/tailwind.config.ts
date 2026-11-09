import type { Config } from "tailwindcss";

// Orange is for actions (buttons, the star, the dot); mint is for money moving (phase-05 §4).
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        dim: "rgb(var(--dim) / <alpha-value>)",
        money: "rgb(var(--money) / <alpha-value>)",
        bad: "rgb(var(--bad) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "ui-serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      transitionTimingFunction: {
        expo: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
} satisfies Config;
