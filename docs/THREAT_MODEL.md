# Threat model

This model covers the official deployment. Vulnerability reporting is in [SECURITY.md](../SECURITY.md).

## Goals

- Keep private submissions, originals, identities, contacts, notes, and backups private.
- Stop unauthorized publication, moderation, roles, deletion, merges, and original downloads.
- Keep moderation decisions attributable and reviewable.
- Resist OAuth, magic-link, linking, replay, and session takeover.
- Bound storage, decoding, queries, notifications, and search caused by untrusted input.
- Trace every production release to reviewed source.

Availability matters, but an outage must not open an unsafe fallback.

## Actors

- **Visitors** read public material and may create an account to use the correction route.
- **Members** submit moderated content, file appeals, and manage their identities.
- **Reported subjects** may be hostile and still need a safe correction route.
- **Moderators** see private queues but cannot manage every role or any deployment.
- **Administrators** handle destructive operations after step-up checks.
- **Maintainers** change code and deploy through protected GitHub/Cloudflare paths.
- **Cloudflare, Discord, Resend, and GitHub** are trusted only for their documented functions.

Compromised member and moderator accounts are in scope. Full control of Cloudflare, repository ownership, or an administrator's provider account is a dependency incident. Product controls should still limit damage and leave useful audit history.

## Untrusted input

Assume an attacker controls route, query, and body data; multipart framing; filenames and bytes; cookies and headers; OAuth errors and profile fields; email input; stored content and metadata; provider failures; pull requests; dependencies; build scripts; and release inputs.

## Main threats

### False reports and harassment

Attackers may mass-submit claims, impersonate somebody, add unrelated personal data, or brigade a subject. Normal reports need authentication. Public writes use Turnstile and atomic quotas, and all content starts private. Staff review identity, duplicates, and visible PII. Conflicted staff recuse, and appeals remain available. These checks do not prove a claim.

### Broken access control

Attackers may enumerate IDs, change role parameters, call admin routes directly, or reuse privileged URLs. Controls include central D1 sessions and roles, explicit public DTOs, opaque asset IDs, publication conditions in public queries, fresh step-up for risky actions, and audits tied to the authenticated actor.

### Account takeover

The account risks are OAuth login CSRF, callback interception, state replay, guessed or replayed magic links, email enumeration, fixation, linking takeover, and stolen cookies. Controls are bound one-time transactions, exact callbacks, hashed short-lived tokens, neutral responses, host-only secure cookies, session rotation and revocation, CSRF, and proof of both identities when linking. Details are in [AUTHENTICATION.md](AUTHENTICATION.md).

### Malicious evidence

Files may lie about type, carry metadata, exhaust a decoder, exploit a parser, contain active content, or visibly expose private data. Controls include signature and decode checks, byte, pixel, and edge limits, raster-only input, server re-encoding, animation removal, private originals, D1-gated derivatives, attachment delivery for originals, and human review of visible PII.

Re-encoding removes hidden metadata. It cannot remove secrets visible in the pixels.

### Injection and rendering

Stored text may target SQL, HTML, links, or notification markup. Queries are parameterized. React escapes text, links are constrained, untrusted HTML is never rendered, notifications are minimal, and security headers are set.

### Resource abuse

Attackers may race quotas, send large multipart bodies, force broad searches, trigger email, or submit invalid images. Controls include atomic quota reservation before writes, hard body, file, and image limits, indexed pagination, outbox deduplication, provider timeouts, retry ceilings, and no quota refund when spam is removed.

### Discord integrations

A leaked bot token, bad hierarchy, or leaked webhook could change Discord roles or operational messages. Website rank is the only rank authority. The bot manages six zero-permission roles, has exactly Manage Roles, and stays below staff. It preserves unrelated roles. Provider IDs are encrypted, cleanup is bounded, provider origins are fixed, mentions are suppressed, destinations are separate, and payloads and retries have limits.

Discord roles never grant website staff access. The same Worker writes status, so a Worker or Cloudflare outage appears only as a stale timestamp. Out-of-band alerting needs an independent monitor.

The security monitor is an operational signal, not attribution. VPNs, NAT, and shared networks make network identity unreliable. It uses a fixed private channel, fixed provider origins, a zone-scoped read-only token, daily HMAC aliases, normalized endpoints, mention suppression, deduplication, and 72-hour deletion. Raw IPs, query strings, bodies, cookies, tokens, account IDs, and full user agents are excluded.

### Supply chain and deployment

Supply-chain risks include malicious packages, mutable Actions, secrets reaching forks, unreviewed local deploys, and artifact substitution. Controls are a lockfile, SHA-pinned Actions, dependency review, CodeQL, publication and license scans, protected environments, secret-free PR jobs, checksums, provenance, and deployment of the reviewed artifact.

## Privacy failures we test for

- Searching private contacts through a public route
- Learning account existence from magic-link wording
- Identifying a reporter through notifications, logs, filenames, EXIF, or public audit actors
- Guessing an original object or reusing an admin URL
- Recovering deleted private data through a public backup path

## What remains risky

Moderators can misuse valid access. Sanitized images may still show personal data. Providers receive data even when it is minimized. Public allegations can cause harm despite labels and review. Large infrastructure attacks may exceed application controls.

Least privilege, fresh auth, audits, recusal, data minimization, private provider payloads, correction rights, backups, and incident drills reduce those risks.

Review this model when adding an identity provider, upload type, public API, notification destination, analytics product, or privileged role.
