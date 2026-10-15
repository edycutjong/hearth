import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Mukta, Rozha_One } from "next/font/google";
import "./globals.css";
import { OG_ALT, OG_DESC, OG_IMAGE, OG_TITLE } from "@/lib/og";

const rozha = Rozha_One({ weight: "400", subsets: ["latin", "devanagari"], variable: "--font-rozha", display: "swap" });
const mukta = Mukta({ weight: ["400", "500", "600", "700"], subsets: ["latin", "devanagari"], variable: "--font-mukta", display: "swap" });
const plex = IBM_Plex_Mono({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-plex", display: "swap" });

// Absolute card URLs need an origin: the custom domain once it resolves (HEARTH_PUBLIC_URL), else the production alias.
const SITE = (process.env.HEARTH_PUBLIC_URL?.trim() || "https://hearth-alpha-six.vercel.app").replace(/\/+$/, "");

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Hearth — keep the voice notes from home",
  description:
    "Forward the family voice notes. NVIDIA ASR and NanoCodec on Nebius keep each voice as codec tokens, searchable in Hindi, with quote-gated reminders.",
  authors: [{ name: "Edy Cu" }],
  icons: { icon: "/icon.svg" },
  openGraph: {
    type: "website",
    siteName: "Hearth",
    title: OG_TITLE,
    description: OG_DESC,
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: OG_ALT }],
  },
  twitter: { card: "summary_large_image", title: OG_TITLE, description: OG_DESC, images: [OG_IMAGE] },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#e6edf1" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${rozha.variable} ${mukta.variable} ${plex.variable}`}>
      <body>{children}</body>
    </html>
  );
}
