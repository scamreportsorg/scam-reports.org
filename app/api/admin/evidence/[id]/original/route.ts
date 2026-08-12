import { authErrorResponse, AuthError, requireFreshModerator } from "@/lib/auth";
import { auditEvidenceAccess, getEvidenceAsset, getEvidenceOriginalObject } from "@/lib/evidence";
import { privateEvidenceHeaders } from "@/lib/evidence-response";

function downloadExtension(contentType: string) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireFreshModerator(request, 600);
    const { id } = await context.params;
    if (!/^EVA-[0-9a-f-]{36}$/i.test(id)) {
      return new Response("Evidence not found.", {
        status: 404,
        headers: privateEvidenceHeaders(),
      });
    }
    const asset = await getEvidenceAsset(id);
    if (!asset) {
      return new Response("Evidence not found.", {
        status: 404,
        headers: privateEvidenceHeaders(),
      });
    }
    const object = await getEvidenceOriginalObject(asset);
    if (!object) {
      return new Response("Original evidence not found.", {
        status: 404,
        headers: privateEvidenceHeaders(),
      });
    }

    await auditEvidenceAccess(
      asset,
      "evidence.original_downloaded",
      `${principal.account.handle} (${principal.account.id})`,
      `Original bytes downloaded for evidence asset ${asset.id}.`,
    );

    const metadataHeaders = new Headers();
    object.writeHttpMetadata(metadataHeaders);
    const headers = privateEvidenceHeaders(metadataHeaders);
    headers.set("Content-Type", asset.originalContentType);
    headers.set("Content-Length", String(asset.originalSize));
    headers.set(
      "Content-Disposition",
      `attachment; filename="${asset.id}.${downloadExtension(asset.originalContentType)}"; filename*=UTF-8''${encodeURIComponent(asset.originalFilename)}`,
    );
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("Original evidence download failed", error);
    return new Response("Evidence unavailable.", {
      status: 503,
      headers: privateEvidenceHeaders(),
    });
  }
}
