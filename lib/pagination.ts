export function pageBounds(page = 1, pageSize = 25, maximumPageSize = 100) {
  const safePage = Math.max(1, Math.trunc(page));
  const safePageSize = Math.min(maximumPageSize, Math.max(1, Math.trunc(pageSize)));

  return {
    page: safePage,
    pageSize: safePageSize,
    offset: (safePage - 1) * safePageSize,
  };
}

export function pageFromRequest(request: Request) {
  const value = Number(new URL(request.url).searchParams.get("page") ?? "1");
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

export function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
