import { getCsrfCookie, getOptionalSession, noStoreHeaders } from "@/lib/auth";

export async function GET(request: Request) {
  const principal = await getOptionalSession(request);
  if (!principal) {
    return Response.json({ authenticated: false }, { headers: noStoreHeaders() });
  }
  return Response.json(
    {
      authenticated: true,
      account: {
        id: principal.account.id,
        handle: principal.account.handle,
        role: principal.account.role,
        createdAt: principal.account.createdAt,
      },
      csrfToken: getCsrfCookie(request),
    },
    { headers: noStoreHeaders() },
  );
}
