# Authentication and account operations

An account may use Discord OAuth, an email magic link, or both. There is no shared admin password, API-key login header, or trusted identity-header shortcut.

## Hard rules

- Provider identities are private and separate from the public handle.
- Cookies contain opaque bearer values; D1 stores their hashes.
- Browser writes need the configured Origin and a CSRF value bound to that session.
- Linking proves the current session and the new provider in the same browser flow.
- Staff keep both Discord and email linked. Destructive work also needs recent confirmation from both providers in the current session.
- Role and status changes invalidate old sessions through `role_version`.
- Provider and configuration failures close the route. They never open a password or header fallback.

## Accounts and provider identities

`accounts` holds the public handle, role, status, and role version. `account_identities` holds the linked Discord or email identity. Public account responses contain neither provider IDs nor email addresses.

Equality checks use an HMAC derived from `IDENTITY_HASH_KEY`. Values that must be recovered are encrypted with `IDENTITY_ENCRYPTION_KEY`. A provider identity belongs to one account, and an account has at most one identity for each provider. Similar handles, Discord names, or email text do not merge accounts.

Handle changes return `409 handle_taken` only when `accounts.handle_normalized` hits its uniqueness constraint. Other D1 failures return `503 auth_unavailable` instead of pretending the handle was taken.

## Discord OAuth

Discord uses authorization code plus PKCE. The transaction lasts ten minutes and stores:

- a hashed one-time `state`;
- a hashed HttpOnly browser secret;
- an encrypted PKCE verifier;
- `login` or `link` mode;
- the return path;
- for linking, the account and session that started it.

The callback consumes that transaction atomically. A link callback must arrive in the same active session. The Discord access token is used once to fetch the profile and is not kept as an account credential.

The callback must be exactly `${AUTH_APP_ORIGIN}/api/auth/discord/callback` and must match the Discord application.

## Email magic links

A token contains 32 random bytes, is stored only as a hash, and expires after 15 minutes. The request route uses Turnstile, neutral wording, and separate quotas for the email and network subjects.

Login links are bound to the requesting browser. Opening one elsewhere fails without consuming it. Successful use deletes it atomically, so it cannot be replayed. A link token also records the account and session that began the flow and cannot attach an email somewhere else.

Resend sends from `RESEND_FROM`. Never log magic-link URLs, OAuth codes, raw tokens, cookies, or provider responses. Never place a session or CSRF value in a URL, `localStorage`, or `sessionStorage`.

## Sessions and cookies

Session values contain 32 random bytes. The idle limit is seven days and the absolute limit is 30 days. Activity may refresh the idle timestamp after five minutes but never moves the absolute expiry. Fresh-auth checks use the original `authenticated_at`.

A new login creates another session without signing out other devices. Linking or removing a provider revokes every session for the account and creates one replacement. Role or status version changes invalidate older sessions.

`AUTH_APP_ORIGIN` selects the cookie names:

| Origin     | Session cookie      | CSRF cookie      | Attributes                                                |
| ---------- | ------------------- | ---------------- | --------------------------------------------------------- |
| HTTPS      | `__Host-sr_session` | `__Host-sr_csrf` | `Secure`, `Path=/`, `SameSite=Lax`; session is `HttpOnly` |
| Local HTTP | `sr_session`        | `sr_csrf`        | `Path=/`, `SameSite=Lax`; session is `HttpOnly`           |

Creation, parsing, SSR, and clearing all use that one namespace. If the request scheme does not match the configured origin, authentication fails; it does not try the other cookie name. `AUTH_APP_ORIGIN` must be the exact visible origin with no path, query, or fragment.

The CSRF cookie is readable so the client can copy it into a form field or `X-CSRF-Token`. A valid write still needs an allowed `Origin`, the session cookie, equal submitted and cookie CSRF values, and the matching CSRF hash on the D1 session. The CSRF cookie by itself authenticates nobody.

Logout repeats the Origin and CSRF checks, deletes the D1 session, and clears both cookies.

## Staff and step-up

Roles are `member`, `moderator`, and `admin`. Privileged routes resolve the D1 session and check the role on the server. Every `/api/admin/*` route needs a fresh session, normally at most ten minutes old.

Changing a role or account status, or permanently deleting an account, report, evidence item, submission, appeal, review, or reply, also needs Discord and email confirmation from the same session within ten minutes. Timestamps from separate sessions cannot be combined.

Downloading an original evidence file needs fresh moderator auth and creates an audit event. It does not use the dual-provider confirmation reserved for destructive actions. The last active administrator cannot be demoted, suspended, or deleted.

If either provider is down, its flow is unavailable. Do not replace it with a temporary password, header, or shared key. Keep at least two independent administrators.

## First administrator

Bootstrap is a one-time claim, not another login method:

1. Put `BOOTSTRAP_DISCORD_ID` and `BOOTSTRAP_ADMIN_EMAIL` in the target Worker's runtime secrets. One without the other fails closed.
2. Sign in with one exact identity and link the second to the same account.
3. Promotion occurs only when both keyed hashes match and `bootstrap_admin_claimed` is absent.
4. Confirm the new admin access with fresh auth and establish a second independent administrator.
5. Remove both bootstrap secrets but leave the database marker.

Never commit bootstrap values or copy them into Actions. Recovery uses a reviewed D1 procedure or migration, not weaker runtime checks.

## Environment and release check

- `AUTH_RUNTIME_ENV` matches the environment.
- `AUTH_APP_ORIGIN` is the exact public HTTPS origin outside local development.
- `IDENTITY_HASH_KEY`, `IDENTITY_ENCRYPTION_KEY`, and `INTAKE_PEPPER` are independent secrets of the required size.
- Discord credentials and callback belong to that environment only.
- `RESEND_FROM` uses a verified domain appropriate for the environment.
- Turnstile hostname and action checks match the origin.
- Staging and production have separate apps, secrets, D1 databases, and cookies.
- Runtime secrets stay in Cloudflare, not source or release artifacts.
- Post-cutover tests cover Discord, email, session refresh, a CSRF-protected account update, and logout on the apex origin.

`npm run setup:local` creates independent local keys and Cloudflare's localhost test pair without overwriting an existing file. Provider sign-in still needs separate development credentials.

Before release, run `npm run test:security`, `npm test`, and `npm run test:e2e`. The main coverage lives in `auth-security`, `session-bound-step-up`, `admin-accounts`, and the authentication Playwright specs.
