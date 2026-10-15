import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Memoria — agents that remember",
  description: "A living world where AI agents remember, negotiate, and learn together. Powered by FalkorDB.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
