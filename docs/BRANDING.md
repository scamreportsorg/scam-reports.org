# Branding

There are two versions of the same mark: a square `SR / SCAM` emblem for avatars and the favicon, and a wide masthead with `SCAM-REPORTS.ORG`. They should look like one identity at a glance.

## Source files

- [`scam-reports-emblem-chroma.png`](../assets/brand/scam-reports-emblem-chroma.png) is the ImageGen source on chroma.
- [`scam-reports-emblem-master.png`](../assets/brand/scam-reports-emblem-master.png) is the transparent full-size emblem.
- [`scam-reports-wordmark-original.png`](../assets/brand/scam-reports-wordmark-original.png) is the cropped wordmark from the ImageGen output.
- [`scam-reports-wordmark-master.png`](../assets/brand/scam-reports-wordmark-master.png) is the reproducible masthead composite.

OpenAI ImageGen produced the source emblem and horizontal wordmark. The backgrounds were removed, then the artwork was cropped, checked, and exported locally. The build script only assembles and recolors those existing pixels; it does not create new artwork.

Rebuild the public files with:

```bash
node scripts/build-brand-assets.mjs
```

It writes:

- `public/brand/scam-reports-emblem.png`: 512 × 512 avatar
- `public/brand/sr-mark.png`: 96 × 96 raster mark
- `public/favicon.ico`: standard browser favicon built from the raster mark
- `public/brand/scam-reports-wordmark.webp`: 760 × 138 masthead
- `public/brand/scam-reports-social.png`: 1200 × 630 share image

The details to preserve are the silver `S`, cyan `R`, worn red `SCAM` plate, uneven fasteners, and exposed fingerprint. The emblem has no backing disc. In the masthead, the emblem and wordmark share the same visible top and bottom.

## Using the mark

- Use the square mark when the domain text would be unreadable.
- Use the full masthead when there is enough width.
- Use a dark background without visual clutter.
- Keep the `SCAM` plate attached to the emblem.
- Never put report counts, usernames, or evidence into the artwork.

Scam-Reports.org is independent of ElitePvPers, UnknownCheats, and other gaming communities. Their names and assets are not part of this brand.
