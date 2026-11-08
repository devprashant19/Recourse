import type { Config } from "tailwindcss";

// One accent colour, used only for money moving (design rule, phase-05 §4).
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "media",
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
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
