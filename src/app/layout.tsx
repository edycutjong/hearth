import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Mukta, Rozha_One } from "next/font/google";
import "./globals.css";

const rozha = Rozha_One({ weight: "400", subsets: ["latin", "devanagari"], variable: "--font-rozha", display: "swap" });
const mukta = Mukta({ weight: ["400", "500", "600", "700"], subsets: ["latin", "devanagari"], variable: "--font-mukta", display: "swap" });
const plex = IBM_Plex_Mono({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-plex", display: "swap" });

export const metadata: Metadata = {
  title: "Hearth — keep the voice notes from home",
  description:
    "Forward the family voice notes. NVIDIA's speech recogniser and NanoCodec, running on Nebius, keep each voice as codec tokens with a searchable Hindi transcript; every promise in it becomes a reminder quoted word for word.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#e6edf1" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${rozha.variable} ${mukta.variable} ${plex.variable}`}>
      <body>{children}</body>
    </html>
  );
}
