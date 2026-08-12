import { authErrorResponse, AuthError, noStoreHeaders, requireModerator } from "@/lib/auth";
import { getEvidenceLinks, listEvidenceAssets, toAdminEvidenceAsset } from "@/lib/evidence";
import { positiveInteger } from "@/lib/pagination";
import type { EvidenceProcessingState } from "@/lib/types";

const STATES = new Set<EvidenceProcessingState>([
  "uploading",
  "private_ready",
  "public",
  "withheld",
  "failed",
  "deleted",
]);

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const url = new URL(request.url);
    const requestedState = url.searchParams.get("state");
    if (requestedState && !STATES.has(requestedState as EvidenceProcessingState)) {
      return Response.json(
        { error: "Invalid evidence state." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const result = await listEvidenceAssets({
      state: requestedState as EvidenceProcessingState | undefined,
      intakeId: url.searchParams.get("intakeId") || undefined,
      reportId: url.searchParams.get("reportId") || undefined,
      page: positiveInteger(url.searchParams.get("page"), 1),
      pageSize: positiveInteger(url.searchParams.get("pageSize"), 25),
    });
    const items = await Promise.all(
      result.items.map(async (asset) => ({
        ...toAdminEvidenceAsset(asset),
        links: await getEvidenceLinks(asset.id),
        previewUrl: `/api/admin/evidence/${encodeURIComponent(asset.id)}/derivative`,
        originalDownloadUrl: `/api/admin/evidence/${encodeURIComponent(asset.id)}/original`,
      })),
    );
    return Response.json({ ...result, items }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("Evidence queue lookup failed", error);
    return Response.json(
      { error: "Couldn't load evidence." },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}
