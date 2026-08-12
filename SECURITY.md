# Security policy

Security fixes target the latest release and current `main`. An older release is unsupported unless its GitHub Security Advisory says otherwise.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/scamreportsorg/scam-reports.org/security/advisories/new). If that form is down, email [scam.reports.org@gmail.com](mailto:scam.reports.org@gmail.com).

Please include the affected commit or release, the reachable entry point, expected and actual behavior, and the smallest safe reproduction. Do not include real evidence, production credentials, access tokens, or unrelated personal data.

We read the report, try to reproduce it, and then assign severity. We will coordinate a fix and give credit when requested and safe. Give the fix time to ship before publishing details.

Do not post an unfixed issue in a public issue, discussion, pull request, chat message, or scam report. Testing also does not authorize:

- access to somebody else's account or data;
- denial of service;
- social engineering;
- persistence;
- deletion or other destructive work.

## Scope

The public and staff routes, auth, moderation, evidence handling, D1 and migrations, R2, Cloudflare Images, Turnstile, notifications, Discord integrations, backups, CI/CD, and release provenance are in scope.

The sensitive assets are identities, sessions, OAuth and magic-link records, unpublished submissions, staff notes, original evidence, role assignments, audits, backups, deployment credentials, and release artifacts.

Visitors and members are untrusted. Treat request data, files, headers, cookies, OAuth responses, URLs, webhooks, provider responses, database rows, and stored objects as malformed until checked.

Moderators are trusted only for their assigned work. Administrators still need fresh sessions, step-up confirmation, audit logging, and last-admin protection. Cloudflare metadata is trusted only when it comes through the documented platform boundary, not from a look-alike caller header.

The main boundaries are browser to Worker, Worker to providers and storage, private to public moderation state, original to sanitized evidence, outbox to provider, and GitHub Actions to Cloudflare. The fuller model is in [THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Rules the implementation must keep

- Authenticate account operations first, then authorize privileged reads and writes again on the server.
- Require the exact allowed Origin and a session-bound CSRF value for browser mutations.
- Make session, OAuth, magic-link, reset, and bootstrap tokens random, scoped, time-limited, single-use where applicable, and hashed at rest when practical.
- Never expose provider IDs or email addresses on public profiles or APIs.
- Never remove or demote the last active administrator.
- Put Turnstile and atomic rate limits on public intake without storing raw IP addresses.
- Keep unpublished content, private notes, contacts, fingerprints, and storage keys out of public responses.
- Keep originals private. Public evidence must be a decoded, metadata-stripped derivative attached to a published report.
- Never fall back to original bytes after a processing or storage failure.
- Bound upload count, bytes, dimensions, format, and processing work.
- Consume one-time tokens and quotas atomically.
- Take audit actors from the authenticated session, never caller headers.
- Keep secrets and unnecessary personal data out of logs, notifications, CI artifacts, and backups.
- Give fork pull requests no repository, staging, or production secrets.
- Deploy from a reviewed tag whose commit, checksum, SPDX SBOM, and provenance match the artifact.

[AUTHENTICATION.md](docs/AUTHENTICATION.md) records the exact identity, cookie, CSRF, step-up, and bootstrap behavior. [EVIDENCE_POLICY.md](docs/EVIDENCE_POLICY.md) covers files and publication.

## Severity

The highest-impact reports are realistic authorization bypass, account takeover, publication of private or original evidence, identity or note disclosure, stored XSS, SQL injection, unsafe file delivery, arbitrary outbound requests, secret exposure, audit forgery, destructive migrations, and release compromise.

We judge reachability, required access, affected data, scale, persistence, and whether a privacy or moderation boundary was crossed.

Without another security impact, moderation or reputation disagreements, self-XSS, cosmetic spoofing, read-only rate-limit complaints, unsupported releases, and secrets placed only in the tester's own local environment are normally out of scope. So are attacks that already require a fully compromised maintainer or provider account.

## Operator responsibility

Cloudflare, Discord, Resend, GitHub, and browsers can fail. An outage may stop sign-in, intake, image processing, notifications, or deployment. Security checks fail closed; queued notifications do not make private content public.

Operators must keep R2 buckets private, match OAuth callbacks and Turnstile hostnames exactly, protect branches and environments, and keep secrets outside this repository.
