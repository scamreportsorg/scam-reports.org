# Moderation

The archive records safety reports. It is not a retaliation tool or a crowd verdict. Staff review each item before publication. Submission volume does not decide the outcome.

## Statuses

- **Reported:** enough context exists to publish the allegation, but there is no final decision.
- **Under Review:** staff are checking material or waiting for a response.
- **Confirmed:** publishable evidence supports the stated finding under this policy.
- **Rejected:** the claim is unsupported, inaccurate, out of scope, a duplicate without independent value, or otherwise unsuitable.

These labels describe the archive's own review state. They are neither legal judgments nor proof of a rule violation on another platform.

## Intake and review

A useful report identifies the subject, game or community, conduct, approximate time, and evidence source. Insults, hearsay, unexplained crops, unrelated personal data, malware, harassment requests, and reputation manipulation are rejected.

Reviewers may ask for context, original files, transaction records, message links, or proof of involvement. Contacts and originals stay private.

Staff check scope, duplicates, factual wording, identity risk, chronology, provenance, missing context, contradictions, and visible private data. The public note says only what is needed; private reasoning stays private.

High-impact or disputed confirmations need a second review. Staff with a conflict must recuse. A moderator or administrator cannot decide their own report, review, or reply. The server returns `409 self_moderation_forbidden` before changing the queue, audit log, or outbox.

## Evidence, reviews, and replies

Only a sanitized derivative selected by a moderator can become public. Withhold contacts, tokens, payment data, addresses, IPs, minors, unrelated people, and unnecessary conversations. A redaction must not change the meaning. [EVIDENCE_POLICY.md](EVIDENCE_POLICY.md) contains the technical rules.

Reviews and replies are checked for relevance, useful context, respectful language, conflicts, manipulation, and privacy. Agreement does not make an empty review useful. Disagreement does not make a supported review invalid.

Each account has one effective review per report. After an edit, the new revision stays pending while the last approved version remains public. Coordinated voting, paid reviews, undisclosed self-review, and threats may lead to rejection and account restrictions.

## Appeals and corrections

The named person, server staff, an authorized representative, or the original reporter may ask for a correction, identity review, right of reply, privacy review, or status review. An appeal requires a member account so its submitter cannot moderate the same request. Account and contact details stay private.

Staff verify only what is necessary and keep identity evidence private. They preserve the old state in history, review new evidence independently, correct material errors promptly, and do not leave a dispute solely with the first decision-maker. Repeated appeals without new information may be closed, but abuse controls cannot remove the correction route.

## Enforcement and deletion

Restrictions must fit the conduct and be recorded privately. Permanent deletion needs administrator authority, step-up confirmation, and an audit event. A legal hold can pause deletion. Duplicate merges stay reversible.

## Staff applications

Staff applications and role grants follow [GOVERNANCE.md](../GOVERNANCE.md). [PRIVACY.md](PRIVACY.md#moderator-applications) controls retention; [AUTHENTICATION.md](AUTHENTICATION.md) controls step-up and last-admin checks. Application content does not belong on GitHub or another public project channel.

## Transparency

Rules, score formula, statuses, and software are public. Identities, private evidence, staff deliberation, and abuse signals are not. Aggregate reporting must not identify a person or expose a very small private queue.
