import type { Metadata } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "bukitVISTA · Bali Traffic Intelligence",
  description:
    "Traffic conditions, route performance, and mobility insights across Bali.",
  icons: {
    icon: "/brand/bukit-vista-logo.png",
    apple: "/brand/bukit-vista-logo.png"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
