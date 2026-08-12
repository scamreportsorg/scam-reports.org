# What is public and what is not

The service should be auditable without exposing people or private case material.

## Public

- Application and Worker source
- Schema and numbered migrations
- Moderation, evidence, privacy, reputation, governance, security, and deployment rules
- CI workflows, synthetic fixtures, and infrastructure declarations
- Lockfile, third-party notices, release SBOM, checksums, and provenance
- Running version, commit, build time, and schema version
- Published reports, approved reviews and replies, and explicitly published sanitized evidence
- Public handles, approved activity totals, rank rules, and staff-selection criteria
- Aggregate operational figures that cannot identify private cases

## Private

- Credentials, keys, tokens, and provider secrets
- Production D1 rows, R2 objects, backups, logs, and notification payloads
- Original evidence and withheld derivatives
- Pending or rejected allegations and staff discussion
- Contact details and provider identities
- Moderator application answers, provider-link state, review notes, and individual decisions
- Abuse fingerprints, security signals, legal holds, and vulnerability reports

Publishing private data breaks the privacy model. It does not add useful transparency.

## Check the deployed version

`GET /api/version` returns the release version, exact commit, UTC build time, and schema version. Source and release links appear in the footer only when deployed `PUBLIC_SOURCE_AVAILABLE` is `true`.

Do not enable source publication until the exact commit exists in the public repository. Its matching release should include an SPDX SBOM, SHA-256 manifest, and provenance.

## Change history

After the repository opens, normal feature, policy, planning, and release work belongs in public issues and pull requests. Security work may stay private until its coordinated fix ships.

## If private data reaches Git

Automated checks look for credentials, suspicious filenames, exports, unsigned commits, and license problems. They do not replace manual review of fixtures, screenshots, logs, and generated files.

Treat any private-data commit as an incident. Restrict access, rotate affected secrets, remove the data from reachable history with proper coordination, retain only the necessary incident record, and notify affected people when required.
