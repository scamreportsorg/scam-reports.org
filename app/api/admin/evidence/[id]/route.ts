import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { requireConfirmedAdminMutation } from "@/lib/admin-mutation-auth";
import {
  deleteEvidenceAsset,
  EvidenceError,
  getEvidenceAsset,
  getEvidenceLinks,
  moderateEvidenceAsset,
  toAdminEvidenceAsset,
} from "@/lib/evidence";
import type { EvidenceProcessingState } from "@/lib/types";

const STATES = new Set<EvidenceProcessingState>(["private_ready", "public", "withheld"]);

async function evidenceId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return /^EVA-[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireModerator(request, { fresh: true });
    const id = await evidenceId(context);
    if (!id) {
      return Response.json(
        { error: "Evidence not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    const asset = await getEvidenceAsset(id);
    if (!asset) {
      return Response.json(
        { error: "Evidence not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    return Response.json(
      {
        evidence: {
          ...toAdminEvidenceAsset(asset),
          links: await getEvidenceLinks(id),
          previewUrl: `/api/admin/evidence/${encodeURIComponent(id)}/derivative`,
          originalDownloadUrl: `/api/admin/evidence/${encodeURIComponent(id)}/original`,
        },
      },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("Evidence lookup failed", error);
    return Response.json(
      { error: "Couldn't load evidence." },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    await assertCsrf(request);
    const id = await evidenceId(context);
    if (!id) {
      return Response.json(
        { error: "Evidence not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }

    const body = await readAuthJson(request, 32 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Invalid evidence update." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const data = body as Record<string, unknown>;
    if (data.state !== undefined && !STATES.has(data.state as EvidenceProcessingState)) {
      return Response.json(
        { error: "Invalid evidence state." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    if (
      data.reportId !== undefined &&
      data.reportId !== null &&
      typeof data.reportId !== "string"
    ) {
      return Response.json(
        { error: "Invalid report ID." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    if (data.caption !== undefined && typeof data.caption !== "string") {
      return Response.json(
        { error: "Invalid caption." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    if (data.visiblePiiReviewed !== undefined && typeof data.visiblePiiReviewed !== "boolean") {
      return Response.json(
        { error: "Invalid privacy review flag." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    if (data.visiblePiiDetected !== undefined && data.visiblePiiDetected !== true) {
      return Response.json(
        { error: "Visible-PII detection may only be recorded as a permanent decision." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    if (data.legalHold !== undefined) {
      if (principal.account.role !== "admin") {
        return Response.json(
          { error: "Administrator role required to change legal hold." },
          { status: 403, headers: noStoreHeaders() },
        );
      }
      if (typeof data.legalHold !== "boolean") {
        return Response.json(
          { error: "Invalid legal hold flag." },
          { status: 400, headers: noStoreHeaders() },
        );
      }
    }
    if (
      data.displayOrder !== undefined &&
      (!Number.isInteger(data.displayOrder) || Number(data.displayOrder) < 0)
    ) {
      return Response.json(
        { error: "Invalid display order." },
        { status: 400, headers: noStoreHeaders() },
      );
    }

    const updated = await moderateEvidenceAsset(
      id,
      {
        state: data.state as EvidenceProcessingState | undefined,
        reportId: data.reportId as string | null | undefined,
        caption: data.caption as string | undefined,
        displayOrder: data.displayOrder as number | undefined,
        visiblePiiReviewed: data.visiblePiiReviewed as boolean | undefined,
        visiblePiiDetected: data.visiblePiiDetected as boolean | undefined,
        legalHold: data.legalHold as boolean | undefined,
      },
      `${principal.account.handle} (${principal.account.id})`,
    );
    if (!updated) {
      return Response.json(
        { error: "Evidence not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    return Response.json(
      {
        evidence: toAdminEvidenceAsset(updated),
        links: await getEvidenceLinks(id),
      },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    if (error instanceof EvidenceError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    console.error("Evidence moderation failed", error);
    return Response.json(
      { error: "Couldn't update evidence." },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireConfirmedAdminMutation(request);
    const id = await evidenceId(context);
    if (!id) {
      return Response.json(
        { error: "Evidence not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    const removed = await deleteEvidenceAsset(
      id,
      `${principal.account.handle} (${principal.account.id})`,
    );
    if (!removed) {
      return Response.json(
        { error: "Evidence not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    return Response.json({ ok: true }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    if (error instanceof EvidenceError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    console.error("Evidence deletion failed", error);
    return Response.json(
      { error: "Couldn't delete evidence." },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}
