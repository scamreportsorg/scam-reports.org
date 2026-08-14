# Scam-Reports.org

[Scam-Reports.org](https://scam-reports.org) is a searchable report archive for gaming communities. It covers cheating, scam sales, unsafe files, impersonation, marketplace fraud, and ban evasion. The old forum look is intentional. The application runs on Cloudflare Workers, D1, R2, and Cloudflare Images.

Reports are allegations, not verdicts. A submission stays private until a moderator reviews it.

> [!IMPORTANT]
> This repository is only for source code, tests, migrations, and public policy. Keep real reports, evidence, contact details, moderator notes, credentials, database exports, and storage objects out of Git.

## What is included

- Public report profiles, search, filters, status history, and reputation scores
- Discord OAuth and email magic-link accounts
- Moderated reports, reviews, replies, appeals, corrections, and evidence
- Private originals plus metadata-stripped public image copies
- Member and staff roles, public activity ranks, and private staff applications
- Optional Discord role sync, moderation alerts, service status, and security monitoring
- Audit logs, reversible report merges, queued notifications, backups, and restore tools

The official site has no subscriptions, paid ranks, evidence paywalls, or paid moderation results. It is independent of Discord, game publishers, anti-cheat vendors, ElitePvPers, and UnknownCheats. Their code and assets are not used here.

The longer explanations live in:

- [v0.2.10 changelog](CHANGELOG.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Authentication](docs/AUTHENTICATION.md)
- [Community and roles](docs/COMMUNITY.md)
- [Evidence policy](docs/EVIDENCE_POLICY.md)
- [Moderation](docs/MODERATION.md)
- [Privacy](docs/PRIVACY.md)
- [Discord integration](docs/DISCORD_INTEGRATION.md)

## Run it locally

Use Node.js 22.13 or newer and npm. Wrangler comes from the lockfile.

```powershell
npm ci
npm run setup:local
npm run db:migrate:local
npm run dev
```

`setup:local` creates a gitignored `.env.local` with fresh local keys and Cloudflare's documented localhost Turnstile test pair. It neither overwrites an existing file nor prints the keys. Check an existing setup with `npm run setup:local:check`.

An empty local database works. Discord and email sign-in remain off until you add development credentials. Do not reuse production credentials locally.

To run the built Worker:

```powershell
npm run preview
```

## Checks

Before a release pull request, run:

```bash
npm run release:check
```

That is the complete gate: release identity, DCO, production dependency audit, types, formatting, lint, publication history, licenses, browser flows, production build, Node tests, deployment configuration, and Wrangler dry runs.

Browser tests use fictional accounts and local Discord and Resend emulators. They do not need real provider credentials. `npm run test:e2e:ui` opens the same flows interactively.

## Layout

```text
app/          Pages and API routes
components/   Forum UI and forms
db/           Drizzle schema
drizzle/      Numbered D1 migrations
lib/          Auth, moderation, validation, and data services
worker/       Cloudflare Worker entry point
docs/         Technical notes and public policy
tests/        Unit, integration, browser, and fixture coverage
.github/      CI, security, and release automation
```

## Public source, private data

Opening this repository does not open the production data. Reports, private evidence, identities, notes, backups, and secrets remain outside Git. [TRANSPARENCY.md](docs/TRANSPARENCY.md) defines that boundary.

`GET /api/version` identifies the deployed build. Source links appear only after the exact commit and release archive are reachable without signing in. A release is expected to carry checksums, an SPDX SBOM, and build provenance.

## Contributing, security, and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before sending a change. Every non-merge commit needs a DCO sign-off.

Do not put accusations, evidence, appeals, personal data, or an unfixed vulnerability in a public issue. Reports and appeals belong on the site. Security bugs go through [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability).

Copyright (C) 2026 Scam-Reports.org contributors.

The source is [AGPL-3.0-or-later](LICENSE), without warranty. Commercial use is allowed. Anyone serving a modified version over a network must offer Corresponding Source where the AGPL requires it. The official site's no-paywall rule is separate and lives in [FREE_ACCESS.md](docs/FREE_ACCESS.md). Dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
