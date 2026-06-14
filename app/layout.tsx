import type { ReactNode } from "react";
import { Archivo, Space_Mono } from "next/font/google";
import { Providers } from "./providers";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-archivo",
  display: "swap",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});

export const metadata = {
  title: "RemitRoute",
  description:
    "Set one rule. Your money runs itself. An always-on agent on Celo that runs your savings, FX, and remittances, with gas paid in stablecoins.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0B0A09",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${spaceMono.variable}`}>
      <body
        style={{
          margin: 0,
          fontFamily: "var(--font-archivo), system-ui, sans-serif",
          background: "#0B0A09",
          color: "#F2EDE3",
          WebkitFontSmoothing: "antialiased",
          overflowX: "hidden",
        }}
      >
        {/* Shared brand keyframes for the React routes (/app, /dashboard). The
            static marketing pages bring their own. */}
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          ::selection { background:#E9A53C; color:#0B0A09; }
          @keyframes rr-blink { 0%,100% { opacity:1 } 50% { opacity:0.15 } }
          @keyframes rr-pulse { 0% { transform:scale(1); opacity:0.9 } 70% { transform:scale(2.6); opacity:0 } 100% { opacity:0 } }
          @keyframes rr-flash { 0%,100% { opacity:1 } 50% { opacity:0.35 } }
          @keyframes rr-spin { to { transform:rotate(360deg) } }
        `}</style>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
