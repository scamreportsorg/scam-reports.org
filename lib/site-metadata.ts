import type { Metadata } from "next";

const siteName = "Scam-Reports.org";
const socialImage = {
  url: "/brand/scam-reports-social.png",
  width: 1200,
  height: 630,
  alt: "Scam-Reports.org community evidence archive",
};

export function publicPageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  const socialTitle = title === siteName ? title : `${title} | ${siteName}`;

  return {
    ...(title === siteName ? {} : { title }),
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      url: path,
      siteName,
      title: socialTitle,
      description,
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [socialImage.url],
    },
  };
}
