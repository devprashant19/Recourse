import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";
import { Providers } from "./providers";
import { NetworkBadge } from "@/components/network-badge";

export const metadata: Metadata = {
  title: "Recourse",
  description: "Bonded, insured, slashable AI agents on NEAR. Every job leaves a TEE-attested receipt; a failed job is slashed and paid out cross-chain.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const NAV: [string, string][] = [
  ["/agents", "Agents"],
  ["/vaults", "Underwriting"],
  ["/economics", "Economics"],
  ["/verify", "Verify"],
  ["/demo", "Demo"],
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <Providers>
          <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
            <div className="mx-auto flex max-w-6xl items-center gap-4 overflow-x-auto px-4 py-3">
              <Link href="/" className="shrink-0 text-base font-semibold tracking-tight">
                Recourse
              </Link>
              <nav className="flex shrink-0 gap-3 text-sm text-dim">
                {NAV.map(([href, label]) => (
                  <Link key={href} href={href} className="hover:text-ink">
                    {label}
                  </Link>
                ))}
              </nav>
              <div className="ml-auto shrink-0">
                <NetworkBadge />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 pb-16 pt-6">{children}</main>
          <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-dim">
            Built at NEAR HACKATHON 2026 · MIT · Receipts prove which model produced which bytes; they do not prove the output is correct — that is what the arbiter, the appeal and the bond are for.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
