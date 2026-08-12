import type { MetadataRoute } from "next";

const siteUrl = "https://scam-reports.org";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, changeFrequency: "daily", priority: 1 },
    { url: `${siteUrl}/rankings`, changeFrequency: "daily", priority: 0.8 },
    { url: `${siteUrl}/statistics`, changeFrequency: "daily", priority: 0.7 },
    { url: `${siteUrl}/community`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${siteUrl}/community/ranks`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${siteUrl}/submit`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${siteUrl}/appeals`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${siteUrl}/rules`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${siteUrl}/privacy`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${siteUrl}/security`, changeFrequency: "monthly", priority: 0.4 },
  ];
}
