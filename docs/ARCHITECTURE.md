# Architecture

Scam-Reports.org is a server-rendered Vinext application running in a Cloudflare Worker. Public pages are readable without an account. Posting a report, review, reply, or appeal requires a member session, and nothing is published before moderation.

The important boundary is simple: the Worker decides identity, roles, rate limits, publication, and evidence access. Browser state is never trusted as authority.

## Pieces

- **Vinext and React** render the pages, forms, and route handlers.
- **The Worker** handles routing, validation, auth, and response policy.
- **D1** holds accounts, sessions, content, moderation state, audits, quotas, notification jobs, and evidence metadata.
- **R2 originals** stores private evidence under opaque keys.
- **R2 derivatives** stores sanitized images. An object being present there does not make it public.
- **Cloudflare Images** decodes within fixed limits, fixes orientation, removes metadata and animation, and writes WebP copies.
- **Turnstile** protects account and public write routes from basic abuse.
- **Discord and Resend** provide OAuth identity and magic-link delivery.
- **GitHub Actions** checks changes and builds reviewed release artifacts.

## A write request

1. The Worker establishes the canonical origin and reads a size-bounded body.
2. Account routes resolve an opaque session, then check role and CSRF.
3. Public writes pass Turnstile and reserve an atomic quota event.
4. Validation turns the request into typed service input. Raw request objects do not reach persistence code.
5. D1 commits related content, audit, and outbox records together when partial success would be unsafe.
6. Public routes return explicit DTOs instead of spreading database rows.

## Data boundaries

Discord and email identities are separate from public handles. Equality checks use keyed hashes; recoverable provider values are encrypted. Linking proves the current session and the new provider. Similar names never merge accounts. [AUTHENTICATION.md](AUTHENTICATION.md) contains the exact session and provider rules.

Reports, reviews, replies, appeals, and applications use explicit states. Public SQL includes the publication condition itself, so privacy does not depend on a UI filter. Private notes and contacts are absent from public DTOs.

Duplicate reports point to one canonical report. They are not discarded, which preserves provenance, redirects, and the ability to undo a merge.

Evidence starts as a private original. Cloudflare Images produces a bounded, metadata-free copy, a moderator reviews what is visible, and public delivery checks both the asset and its canonical report in D1. There is no public route for an original key. Deletion takes a D1 lease before R2 changes; legal holds and active leases are enforced by triggers. The full state machine is in [EVIDENCE_POLICY.md](EVIDENCE_POLICY.md).

## Search and background work

D1 handles full-text search, filters, pagination, rank totals, and report reputation. List pages select compact fields; evidence and full history load on detail pages. [REPUTATION.md](REPUTATION.md) defines the score.

Notifications use a D1 outbox with leases, bounded retries, and terminal failures. Discord rank jobs recalculate current site state when they run, so an old job still settles on the current rank. Backups and inventories are operator jobs. Web admin never offers a raw backup download.

## Schema and releases

`db/schema.ts` describes the schema. Only numbered files in `drizzle/` are deployment migrations. Requests neither create schema nor seed records. Test data stays synthetic.

D1, R2, callbacks, Turnstile hostnames, and secrets are separate for every environment. Tagged releases carry a checksum, SPDX SBOM, and provenance.
