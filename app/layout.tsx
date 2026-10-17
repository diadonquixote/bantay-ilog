import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bantay Ilog — River Watch",
  description: "Community river-gauge monitoring and flood alerts.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1864ab",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <nav>
            <Link href="/" className="brand">
              Bantay <span>Ilog</span>
            </Link>
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/capture">Capture</Link>
            <Link href="/demo">Demo</Link>
            <Link href="/setup">Setup</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
