import { listReportDirectory, parseDirectorySearchParams } from "@/lib/report-query";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = parseDirectorySearchParams(Object.fromEntries(url.searchParams));
  return Response.json(await listReportDirectory(query), {
    headers: {
      "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
