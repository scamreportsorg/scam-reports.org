import type { Metadata } from "next";
import "./globals.css";

const siteUrl = "https://scam-reports.org";
const description =
  "Scam-Reports.org is a forum-style cross-game archive for moderated cheating and scam reports, evidence profiles, community reviews, and reputation rankings.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "Scam-Reports.org", template: "%s | Scam-Reports.org" },
  description,
  applicationName: "Scam-Reports.org",
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon", sizes: "96x96" },
      { url: "/brand/sr-mark.png", type: "image/png", sizes: "96x96" },
    ],
  },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Scam-Reports.org",
    title: "Scam-Reports.org",
    description,
    images: [
      {
        url: "/brand/scam-reports-social.png",
        width: 1200,
        height: 630,
        alt: "Scam-Reports.org community evidence archive",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Scam-Reports.org",
    description,
    images: ["/brand/scam-reports-social.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
