import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bantay Ilog — River Watch",
  description: "Community river-gauge monitoring and flood alerts.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Bantay Ilog", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1864ab" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1418" },
  ],
};

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/capture", label: "Capture", icon: "📷" },
  { href: "/demo", label: "Demo", icon: "▶️" },
  { href: "/setup", label: "Setup", icon: "⚙️" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <nav>
            <Link href="/" className="brand">
              Bantay <span>Ilog</span>
            </Link>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main id="main">{children}</main>
        {/* Thumb-reachable on a phone held one-handed in the rain. */}
        <nav className="bottom-nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}>
              <b aria-hidden>{n.icon}</b>
              {n.label}
            </Link>
          ))}
        </nav>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
