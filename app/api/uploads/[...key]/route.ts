export async function GET() {
  return new Response(
    "Legacy raw evidence URLs are no longer served. Use the opaque evidence asset URL.",
    {
      status: 410,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export async function DELETE() {
  return Response.json(
    { error: "Legacy evidence mutations are retired. Use the authenticated admin evidence API." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
