import { resolveReport } from "@/lib/reports";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolution = await resolveReport(id);
  if (!resolution) {
    return Response.json({ error: "Report not found." }, { status: 404 });
  }
  if (resolution.redirected) {
    return Response.redirect(
      new URL(`/api/reports/${encodeURIComponent(resolution.canonicalId)}`, request.url),
      308,
    );
  }
  const report = structuredClone(resolution.report);
  delete (report as { views?: number }).views;
  return Response.json(
    { report },
    {
      headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" },
    },
  );
}
