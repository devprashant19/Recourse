// Flat config (ESLint 9). Deliberately minimal for Phase 0: it exists so `pnpm lint`
// is a real check from day 1. Phase 1 can tighten it.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/target/**",
      "**/.data/**",
      "phases/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Stubs carry unused signatures on purpose until their phase fills them in.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
