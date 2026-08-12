import { AuthError } from "./auth-errors";

export function assertIndependentModerator(
  authorAccountId: string | null,
  moderatorAccountId: string | undefined,
) {
  if (!moderatorAccountId || authorAccountId === moderatorAccountId) {
    throw new AuthError(
      409,
      "self_moderation_forbidden",
      "A different moderator must review content submitted by this account.",
    );
  }
}
