import { AuthError } from "./auth-errors";
import { assertCsrf, requireAdmin, type AuthPrincipal } from "./auth-session";

const CONFIRMATION_MAX_AGE_SECONDS = 600;

function hasRecentDualProviderConfirmation(principal: AuthPrincipal, maxAgeSeconds: number) {
  const cutoff = Date.now() - maxAgeSeconds * 1000;
  const { discordAt, emailAt } = principal.session.providerConfirmations;
  return Boolean(
    discordAt && emailAt && Date.parse(discordAt) >= cutoff && Date.parse(emailAt) >= cutoff,
  );
}

export async function requireRecentDualProviderConfirmation(
  principal: AuthPrincipal,
  maxAgeSeconds = CONFIRMATION_MAX_AGE_SECONDS,
) {
  if (hasRecentDualProviderConfirmation(principal, maxAgeSeconds)) return;
  throw new AuthError(
    401,
    "dual_confirmation_required",
    "Confirm this session with Discord and email before changing access or deleting data.",
  );
}

export async function requireConfirmedAdminMutation(request: Request): Promise<AuthPrincipal> {
  const principal = await requireAdmin(request, { fresh: true });
  await assertCsrf(request);
  await requireRecentDualProviderConfirmation(principal);
  return principal;
}
