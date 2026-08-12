import { env } from "cloudflare:workers";
import { getPublicEvidenceAsset } from "@/lib/evidence";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^EVA-[0-9a-f-]{36}$/i.test(id)) {
    return new Response("Evidence not found.", { status: 404 });
  }

  try {
    const publicEvidence = await getPublicEvidenceAsset(id);
    if (!publicEvidence) {
      return new Response("Evidence not found.", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const bucket = (env as unknown as { EVIDENCE_DERIVATIVES?: R2Bucket }).EVIDENCE_DERIVATIVES;
    if (!bucket) {
      return new Response("Evidence storage unavailable.", { status: 503 });
    }
    const object = await bucket.get(publicEvidence.derivativeKey);
    if (!object) {
      return new Response("Evidence not found.", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      object.customMetadata?.sanitized !== "cloudflare-images-webp" ||
      object.customMetadata?.sha256 !== publicEvidence.derivativeSha256 ||
      object.size !== publicEvidence.asset.fileSize
    ) {
      console.error("Public evidence derivative lacks sanitizer provenance", { id });
      return new Response("Evidence unavailable.", {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", publicEvidence.asset.contentType);
    headers.set("Content-Length", String(publicEvidence.asset.fileSize));
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", "sandbox");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Disposition", `inline; filename="${id}.webp"`);
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    return new Response(object.body, { headers });
  } catch (error) {
    console.error("Public evidence lookup failed", error);
    return new Response("Evidence unavailable.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
