import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "murrkit — AI 2D game maker",
  description: "Autonomous Phaser 3 + TypeScript 2D game development with sprite sheets, live Vite hot-reload, headless Playwright playtests, and Gemini vision compare-gate.",
};

/**
 * Inline script: read the persisted theme from localStorage and apply
 * the matching class BEFORE React hydrates, so we never see a flash of
 * the wrong theme. Falls back to dark if anything goes wrong.
 */
const NO_FOUC_SCRIPT = `
(function() {
  try {
    var raw = window.localStorage.getItem('phaser2d.layout.v7');
    var theme = 'dark';
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.theme) theme = parsed.theme;
    }
    document.documentElement.classList.add('theme-' + theme);
  } catch (e) {
    document.documentElement.classList.add('theme-dark');
  }
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FOUC_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
