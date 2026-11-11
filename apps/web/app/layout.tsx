import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Shrikhand } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";
import { Providers } from "./providers";
import { Footer } from "@/components/footer";
import { Nav } from "@/components/nav";
import { Shell } from "@/components/shell";
import { DemoBanner } from "@/components/demo-banner";

const sans = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const display = Shrikhand({ subsets: ["latin"], weight: "400", variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://recourse.near.page"),
  title: "Recourse — Bonded & Insured AI Agents on NEAR",
  description: "Bonded, insured, slashable AI agents on NEAR. Every job leaves a TEE-attested receipt; a failed job is slashed and paid out cross-chain.",
  icons: {
    icon: [
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [
      { url: "/apple-icon.png", sizes: "512x512", type: "image/png" },
    ],
  },
  openGraph: {
    title: "Recourse — Bonded & Insured AI Agents on NEAR",
    description: "Bonded, insured, slashable AI agents on NEAR. Every job leaves a TEE-attested receipt; a failed job is slashed and paid out cross-chain.",
    url: "https://recourse.near.page",
    siteName: "Recourse",
    images: [
      {
        url: "/og-image.png",
        width: 1500,
        height: 500,
        alt: "Recourse on NEAR",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Recourse — Insurance for AI Agents on NEAR",
    description: "Bonded, insured, slashable AI agents on NEAR. Built for NEAR Hackathon 2026.",
    site: "@recoursenear",
    creator: "@recoursenear",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#121414" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        {/* Before paint: lets the motion CSS hide what will animate in. Without JS, nothing is hidden. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Providers>
          <DemoBanner />
          <Nav />
          <Shell>{children}</Shell>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
