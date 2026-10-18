import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import Link from "next/link";
import { BottomNav, TopNav } from "@/components/Nav";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import "./globals.css";

// One self-hosted font (no third-party request from phones); system fonts show until it loads.
// Numbers use its tabular figures, so no separate monospace font is downloaded.
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Bantay Ilog — River Watch", template: "%s · Bantay Ilog" },
  description: "Live river gauge readings and flood alerts from your barangay's volunteer observers.",
  applicationName: "Bantay Ilog",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Bantay Ilog", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e8ebec" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1a21" },
  ],
};

function Mark() {
  return (
    <svg viewBox="0 0 24 32" width="18" height="24" aria-hidden="true" className="brand-mark">
      <rect x="2" y="0" width="20" height="32" rx="2" fill="#fbfbf9" stroke="currentColor" strokeWidth="1.5" />
      <rect x="5" y="3" width="4" height="15" fill="#c8102e" />
      <rect x="5" y="3" width="11" height="3" fill="#c8102e" />
      <rect x="5" y="9" width="11" height="3" fill="#c8102e" />
      <rect x="5" y="15" width="11" height="3" fill="#c8102e" />
      <path d="M2 22 q3 -2 5 0 t5 0 t5 0 t5 0 V30 a2 2 0 0 1 -2 2 H4 a2 2 0 0 1 -2 -2 Z" fill="var(--water)" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="site-header">
          <nav aria-label="Primary">
            <Link href="/" className="brand">
              <Mark />
              <span>
                Bantay <b>Ilog</b>
              </span>
            </Link>
            <TopNav />
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <span>Bantay Ilog · community river watch</span>
          <Link href="/demo">Try the demo</Link>
        </footer>
        <BottomNav />
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
