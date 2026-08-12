import { authErrorResponse, AuthError, requireModerator } from "@/lib/auth";
import { getEvidenceAsset, getEvidenceDerivativeObject } from "@/lib/evidence";
import { privateEvidenceHeaders } from "@/lib/evidence-response";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireModerator(request, { fresh: true });
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
    const object = await getEvidenceDerivativeObject(asset);
    if (!object) {
      return new Response("Sanitized evidence not found.", {
        status: 404,
        headers: privateEvidenceHeaders(),
      });
    }

    const metadataHeaders = new Headers();
    object.writeHttpMetadata(metadataHeaders);
    const headers = privateEvidenceHeaders(metadataHeaders);
    headers.set("Content-Type", asset.derivativeContentType ?? "application/octet-stream");
    headers.set("Content-Disposition", `inline; filename="${id}.webp"`);
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("Evidence derivative preview failed", error);
    return new Response("Evidence unavailable.", {
      status: 503,
      headers: privateEvidenceHeaders(),
    });
  }
}
