// src/app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "ASP Online",
    template: "%s | ASP Online",
  },
  description: "Athena’s Study Parthenon — sign-in, timer, and all-time leaderboard.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}

        {/* Watermark (bottom-right, subtle, non-interactive) */}
        <div
          aria-hidden="true"
          className="fixed bottom-2 right-3 text-xs text-slate-400 opacity-70 pointer-events-none select-none"
        >
          Dane Beels, 2025
        </div>
      </body>
    </html>
  );
}
