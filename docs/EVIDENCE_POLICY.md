# Evidence policy

Short version: originals stay private. Only a separate, processed image may become public, and only after technical checks and human review. Publication is never automatic.

## Input limits

- PNG, JPEG, or WebP, identified by decoding rather than the filename or browser MIME
- At most five files per submission
- At most 5 MiB per file and 20 MiB total
- At most 12 megapixels and 4096 pixels on either edge after decoding

The five-file and 20 MiB totals also apply when staff link evidence to a report. The API returns a useful error; database triggers enforce the same limits under concurrency.

Animated, truncated, polyglot, unsupported, oversized, and undecodable images are rejected. Archives, executables, documents, audio, and video are not accepted at all.

## Processing

1. Allocate an opaque asset ID and a private key for the original.
2. Stream the bytes through an encoded-size limit while calculating SHA-256.
3. Check the raster signature and decode within the dimension limits.
4. Fix orientation and create a WebP no larger than 2560 pixels on either edge.
5. Strip metadata and animation during encoding.
6. Set `private_ready` only after the derivative succeeds.
7. Have a moderator choose `public` or `withheld` and confirm the visible-PII review.

The states are `uploading`, `private_ready`, `public`, `withheld`, `failed`, and `deleted`. Failure never promotes an original or partial output.

An older derivative stays `withheld` unless it has a verified SHA-256 and provenance from the current server-side sanitizer. Otherwise, decode and re-encode it privately through the current Images pipeline. Browser conversion, edited metadata, and operator assertion are not sufficient.

## Human review

Metadata removal cannot hide text that is visible in the picture. Reviewers check for contact details, addresses, tokens, QR codes, unrelated people, minors, unnecessary private conversations, misleading crops, missing chronology, and redactions that change the meaning.

Once an asset is withheld for visible private data, it cannot return to `public`. Redaction creates a new asset with `replaces_evidence_id` rather than overwriting history. The replacement passes sanitization and visible-PII review, then takes over the report link atomically. The source relationship and audit trail remain.

## Delivery and original access

Public delivery starts with an asset ID. The route loads D1, requires `public`, verifies the link to a published canonical report, and only then reads the derivative. It never returns a storage key or original filename.

An original download needs fresh moderator auth, uses attachment and restrictive headers, and writes an audit event. Originals are never embedded in HTML or exposed through permanent signed URLs.

## Retention and deletion

Evidence stays with its case unless law or policy requires earlier removal. Final case deletion removes active objects after administrator confirmation. A legal hold can delay it. Backup copies follow the backup schedule and are unavailable through web admin.

Deletion first takes a conditional D1 lease requiring `legal_hold = 0`. The lease immediately stops public delivery and blocks moderation or a concurrent hold change. Successful R2 deletion finalizes the tombstone and audit event. On failure, the lease returns to private `withheld`. Timed-out leases may be reclaimed. Triggers reject held tombstones and state-machine bypasses.

Missing, corrupt, or failed storage changes the asset state and alerts staff. A public route never tries another bucket as a fallback.

## Migration and logs

Legacy evidence is inventoried by key and hash, imported privately, processed again, and linked to explicit assets. Counts and hashes must reconcile before cutover. Retired raw URLs return `410 Gone`.

Logs may contain asset ID, state, byte count, dimensions, timing, and error class. They must not contain bytes, filenames, storage keys, contacts, signed URLs, or extracted metadata. Staff notifications link to a queue item; they never attach evidence.
