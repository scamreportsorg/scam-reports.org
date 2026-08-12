import { authErrorResponse, AuthError, requireModerator } from "@/lib/auth";
import { getEvidenceAsset, getEvidenceDerivativeObject } from "@/lib/evidence";
import { privateEvidenceHeaders } from "@/lib/evidence-response";
import { validQuarantineKey } from "@/lib/intake-security";

async function assetId(context: { params: Promise<{ key: string[] }> }) {
  const { key } = await context.params;
  const valid = validQuarantineKey(key);
  return valid ? valid.slice("asset/".length) : null;
}

export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  try {
    await requireModerator(request, { fresh: true });
    const id = await assetId(context);
    if (!id) {
      return new Response("Legacy raw evidence is no longer previewed.", {
        status: 410,
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
    headers.set("Content-Disposition", `inline; filename="${asset.id}.webp"`);
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("Private evidence preview failed", error);
    return new Response("Evidence unavailable.", {
      status: 503,
      headers: privateEvidenceHeaders(),
    });
  }
}

export async function DELETE() {
  return Response.json(
    { error: "Legacy evidence mutations are retired. Use the authenticated admin evidence API." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
