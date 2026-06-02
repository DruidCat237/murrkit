import type { Config } from "tailwindcss";

/**
 * v2 — colors are sourced from CSS variables so themes swap without
 * rebuilding tailwind. The named utility classes (`bg-bg`, `text-text`,
 * etc.) resolve through `var(--bg)` / `var(--text)` / etc.
 */
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "var(--bg)",
          subtle:  "var(--bg-subtle)",
          panel:   "var(--bg-panel)",
          overlay: "var(--bg-overlay)",
        },
        line: {
          DEFAULT: "var(--line)",
          strong:  "var(--line-strong)",
        },
        text: {
          DEFAULT: "var(--text)",
          dim:     "var(--text-dim)",
          subtle:  "var(--text-subtle)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hot:     "var(--accent-hot)",
          warn:    "var(--accent-warn)",
        },
        ok:  "var(--ok)",
        err: "var(--err)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        elev: "var(--shadow-elev)",
        glow: "var(--glow-accent)",
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
      },
    },
  },
  plugins: [],
};

export default config;
