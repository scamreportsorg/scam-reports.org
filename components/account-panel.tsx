import type { AccountIdentity, AuthAccount } from "@/lib/auth";
import type { DiscordRankSyncStatus } from "@/lib/discord-rank-sync";
import { SafeLink as Link } from "./safe-link";
import { SectionBox } from "./section-box";
import { AuthTurnstile } from "./auth-turnstile";
import { LinkDiscordForm } from "./link-discord-form";
import { TurnstileSubmitButton } from "./turnstile-submit-button";

export function AccountPanel({
  account,
  identities,
  csrfToken,
  discordRankSync,
  updated,
}: {
  account: AuthAccount;
  identities: AccountIdentity[];
  csrfToken: string;
  discordRankSync: DiscordRankSyncStatus;
  updated?: string;
}) {
  const discord = identities.find((identity) => identity.provider === "discord");
  const email = identities.find((identity) => identity.provider === "email");
  const staff = account.role !== "member";

  return (
    <div className="content-columns account-panel">
      <div>
        {updated && <div className="form-success">Saved.</div>}
        <SectionBox title="Public profile">
          <form method="post" action="/api/auth/account" className="review-form">
            <label>
              Public handle
              <input
                name="handle"
                defaultValue={account.handle}
                minLength={3}
                maxLength={24}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,23}"
                autoComplete="username"
                required
              />
            </label>
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <button className="forum-button" type="submit">
              Save public handle
            </button>
          </form>
          <p className="compact-copy">
            Public page:{" "}
            <Link href={`/members/${encodeURIComponent(account.handle)}`}>
              /members/{account.handle}
            </Link>
            . Contact details and provider IDs stay hidden.
          </p>
        </SectionBox>

        <SectionBox title="Sign-in identities" className="account-identities-box">
          <div className="identity-table">
            <div>
              <span>Discord</span>
              <strong>{discord?.displayHint ?? "Not linked"}</strong>
            </div>
            <div>
              <span>Email</span>
              <strong>{email?.displayHint ?? "Not linked"}</strong>
            </div>
          </div>

          {!discord && <LinkDiscordForm csrfToken={csrfToken} />}
          {!email && (
            <form method="post" action="/api/auth/magic/request" className="review-form">
              <input type="hidden" name="purpose" value="link" />
              <input type="hidden" name="returnTo" value="/account?updated=identity" />
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <label>
                Link an email address
                <input type="email" name="email" maxLength={254} required />
              </label>
              <AuthTurnstile action="magic_link" />
              <TurnstileSubmitButton>Send verification link</TurnstileSubmitButton>
            </form>
          )}

          {!staff && identities.length > 1 && (
            <div className="thread-actions">
              {identities.map((identity) => (
                <form
                  method="post"
                  action={`/api/auth/identities/${identity.provider}`}
                  key={identity.provider}
                >
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <button className="forum-button subtle" type="submit">
                    Unlink {identity.provider === "discord" ? "Discord" : "email"}
                  </button>
                </form>
              ))}
            </div>
          )}
          {staff && (
            <>
              <p className="thread-notice">
                Staff accounts need both sign-in methods. Confirm both again within ten minutes to
                change roles or account status, or to permanently delete data.
              </p>
              {discord && (
                <LinkDiscordForm
                  csrfToken={csrfToken}
                  label="Reconfirm Discord"
                  returnTo="/account?updated=discord-confirmed"
                />
              )}
              {email && (
                <form method="post" action="/api/auth/magic/request" className="review-form">
                  <input type="hidden" name="purpose" value="link" />
                  <input type="hidden" name="returnTo" value="/admin" />
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <label>
                    Reconfirm your email
                    <input type="email" name="email" maxLength={254} required />
                  </label>
                  <AuthTurnstile action="magic_link" />
                  <TurnstileSubmitButton>Send reconfirmation link</TurnstileSubmitButton>
                </form>
              )}
            </>
          )}
        </SectionBox>

        <SectionBox title="Discord community rank">
          {!discord ? (
            <p className="thread-notice">Link Discord to get your website rank on the server.</p>
          ) : !discordRankSync.configured ? (
            <p className="thread-notice">
              Discord rank sync isn&apos;t enabled here yet. Your website rank still works.
            </p>
          ) : (
            <>
              <div className="identity-table">
                <div>
                  <span>Website rank</span>
                  <strong>
                    {discordRankSync.desiredRank
                      ? `Lv${discordRankSync.desiredRank.level} ${discordRankSync.desiredRank.name}`
                      : "Newcomer"}
                  </strong>
                </div>
                <div>
                  <span>Discord role</span>
                  <strong>
                    {discordRankSync.appliedRank
                      ? `Lv${discordRankSync.appliedRank.level} ${discordRankSync.appliedRank.name}`
                      : "Not synced yet"}
                  </strong>
                </div>
                <div>
                  <span>Sync state</span>
                  <strong>{discordRankSync.status.replaceAll("_", " ")}</strong>
                </div>
              </div>
              {discordRankSync.status === "not_in_guild" && (
                <p className="thread-notice">
                  This Discord account isn&apos;t in the community server. Join it, then sync again.
                </p>
              )}
              <div className="thread-actions">
                {discordRankSync.communityInviteUrl &&
                  discordRankSync.status === "not_in_guild" && (
                    <Link href={discordRankSync.communityInviteUrl}>Join the Discord server</Link>
                  )}
                <form method="post" action="/api/auth/discord/rank-sync">
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <button className="forum-button subtle" type="submit">
                    Sync Discord rank
                  </button>
                </form>
              </div>
            </>
          )}
        </SectionBox>
      </div>

      <aside>
        <SectionBox title="Account status">
          <div className="identity-table">
            <div>
              <span>Role</span>
              <strong>{account.role}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{account.status}</strong>
            </div>
            <div>
              <span>Joined</span>
              <strong>{account.createdAt.slice(0, 10)}</strong>
            </div>
          </div>
        </SectionBox>
        <SectionBox title="Session">
          <form method="post" action="/api/auth/logout">
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <button className="forum-button subtle full" type="submit">
              Sign out
            </button>
          </form>
        </SectionBox>
      </aside>
    </div>
  );
}
