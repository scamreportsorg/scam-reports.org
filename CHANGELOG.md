# v0.2.10

First release cut directly from the public source tree

This one is mostly security hardening, safer intake handling, admin cleanup and making the release process actually reproducible

## Breaking Changes

- Magic link sign in is now bound to the browser that requested the link. Links opened on another device, or created before schema 22, need to be requested again

- Appeals now require an authenticated account. Appeal identity comes from the active session instead of user supplied attribution

- Public report view counts have been removed. Reading reports no longer writes to D1, and view based sorting and statistics are gone with it

## New Features

- Added the new admin console for accounts, moderation queues, evidence, audits and operations with shared responsive layouts

- Account role and status changes now expose dirty, saved and failed state directly on the affected row

- Admin actions blocked by step up authentication now link directly to reconfirmation

- Public routes now include canonical, Open Graph and Twitter metadata while private account, authentication and admin routes explicitly opt out of indexing

- Added a local error boundary with retry and navigation controls instead of falling through to the framework error page

- Navigation now tracks the active section consistently across public and authenticated pages

## Security

- Added byte limits for JSON, URL encoded and multipart request bodies

- Authentication, origin validation, CSRF, Turnstile and attempt quotas now run before expensive report and appeal body processing

- Failed multi file evidence intake now rolls back associated D1 records and original, derivative and backup R2 objects

- Evidence cleanup is scoped to its owning intake and is safe to retry

- Destructive admin actions and account access changes now share the same ordered authorization path using a fresh admin session, CSRF and recent Discord and email confirmation

- Appeal recusal now applies to administrators as well as moderators

- Legacy anonymous appeal audit entries are displayed as unverified rather than trusting their supplied actor name

- Discord, Resend, Turnstile and Cloudflare requests now use fixed origin and path rules, manual redirect handling, bounded timeouts and bounded JSON responses

- Image transforms now accept only known local assets, approved widths and the configured quality level

- Image transform cache keys are canonical, duplicate work is coalesced and transform concurrency is bounded

- HTTP and www traffic now redirect to the fixed `https://scam-reports.org` origin while preserving path and query

- Staging rejects placeholder access credentials and bounds login input

- Authentication, admin and private evidence error responses now consistently use `no-store`

## Bug Fixes

- Report, appeal and community ID allocation now checks the target table and retries generated collisions

- Public report reads no longer perform a D1 write

- Empty statistics datasets now show a real empty state instead of rendering an empty chart or fake recalculation timestamp

- Discord security monitoring now uses normalized Cloudflare WAF rollups

- Rejected application responses are no longer stored as attacker request records

- Improved focus states, mobile hit targets, form sizing, heading order, contrast and layouts down to 320px

## Release Engineering

- Formatting, linting, type checking, dependency auditing, Node tests, browser tests, production builds, license checks, publication checks and Wrangler smoke and cutover checks now run through one release gate

- Publication scanning now checks sensitive paths, binaries, credential shaped assignments, production looking Discord and resource IDs, GitHub hosted metadata and reachable Git history without printing inspected values

- Version, package metadata, annotated tag, source commit, schema version, generated Worker configuration and public source state must agree before a release candidate can be built

- Protected release candidates now produce a deployment archive, SPDX SBOM, `SHA256SUMS` and build provenance before the draft release is created

## Public Source

Application code, migrations, tests, policies and release tooling are now published under AGPL

Production reports, private evidence, identities, moderator notes, backups and credentials remain outside Git, because apparently publishing the source code does not require publishing the database too

Security testing is welcome within the scope defined in `SECURITY.md`

Merged contributors can claim the glowing Contributor role on Discord

Source commit: `74221b295c354c667161cd55322e8d7f19520fce`
