# Privacy design

These are implementation rules for contributors and operators, not jurisdiction-specific legal advice. Every operator still needs a public notice matching its identity, location, providers, retention, and lawful basis.

## Data groups

**Public:** published report details, selected subject IDs, status, dates, public notes, approved sanitized evidence, approved reviews and replies, public handles, limited account statistics, aggregate statistics, and source version.

**Restricted:** pending or rejected submissions and revisions, staff applications and notes, reporter and appellant contacts, staff deliberation, conflicts, abuse signals, original evidence, and withheld derivatives.

**Security and operations:** hashed session, OAuth, magic-link, identity, and rate values; encrypted provider IDs; linked-provider eligibility; secrets; webhook credentials; backups; logs; and restore records.

## Minimize it

- Collect only what identity, moderation, correction, security, and operation require.
- Keep public handles separate from provider IDs and email addresses.
- Build public DTOs from allowlists. Never serialize a complete database row.
- Store keyed fingerprints instead of raw IPs for rate limits and attack monitoring.
- The security monitor sees a source address only long enough to make a daily HMAC. Discord receives the fingerprint, country, and ASN, never the address.
- Notifications contain an event type, opaque case ID, and protected link, not report text, names, contacts, or evidence.
- Logs use internal IDs and error classes, not secrets or user content.
- Do not add advertising IDs or cross-site tracking to the core app.
- Application answers and provider-link state are visible only to the applicant, where supported, and authorized staff. They never enter public profiles, ranks, APIs, notifications, or CI.

## User choices and corrections

Members can manage linked identities and their public handle, and they can log out. [AUTHENTICATION.md](AUTHENTICATION.md) defines that lifecycle. Subjects and reporters may appeal for a correction, identity dispute, reply, privacy review, or status review. Verification collected for an appeal stays private.

Deletion requests are weighed against disputes, fraud prevention, audit integrity, legal duties, and documented holds. Sometimes a visible correction is safer than silently removing material history.

## Retention

Auth transactions and sessions expire automatically. Rate events are deleted after their enforcement and audit window. Private case data remains only while moderation, correction, safety, or law requires it. Backups have a separate schedule and are not normal application data.

A retention change needs a cleanup plan, operator review, updated public notice, and tests proving deletion cannot publish or cross-link private objects.

### Moderator applications

- Pending and under-review applications expire after 90 days without activity by the applicant or reviewer. Expiry immediately erases answers, notes, and the reviewer link.
- Withdrawn, rejected, and accepted application text is erased 90 days after the final status.
- Cleanup clears motivation, experience, timezone, availability, languages, conflicts, notes, and reviewer link. It then sets `answers_erased_at`.
- Minimal workflow metadata remains: application ID, applicant reference, status, confirmation flag, and lifecycle/redaction timestamps.
- One `system:retention` audit event records the application ID, terminal status, and redaction time without identity or free text.
- The normal application table has no legal-hold bypass. Preservation required by law belongs in a separate, tightly restricted record. The application copy is still redacted.

Scheduled cleanup is bounded and idempotent. Operators monitor it and rerun it after an outage. A stored due timestamp alone does not satisfy this policy.

## Providers

Cloudflare runs the app, storage, and image processing. Discord provides optional OAuth and rank roles. Resend sends magic links and staff email. GitHub hosts source and releases. Each receives only the data needed for its job.

Rank sync sends Discord the linked member ID and one cosmetic rank. Provider IDs are encrypted at rest. Unlinking, suspension, and deletion queue role cleanup. An orphaned encrypted cleanup target expires after 30 days.

Private moderation webhooks contain an event type, case ID, and protected link. Public status has only coarse component states, version, and timing. Neither includes private cases, queue counts, identities, raw provider errors, or credentials.

The private security monitor uses a zone-scoped, read-only Cloudflare Analytics token. Queries omit URL query strings and user agents. D1 keeps the normalized endpoint, coarse detection and action, daily source HMAC, country, ASN, counts, and timestamps. Observations expire after 20 minutes and incident rollups after 72 hours. Its Discord channel stays staff-only.

## Source-code boundary

This repository holds code, policies, migrations, and synthetic fixtures. Production databases, objects, identities, evidence, application records, secrets, and raw logs remain outside it. Application discussions stay in the website flow.
