# Governance

The code project and the live moderation team are separate. A site moderator does not automatically get repository or production access. A maintainer does not automatically get private report access.

## Who does what

- **Contributors** send code, tests, docs, and issues under the DCO.
- **Maintainers** triage and review repository work.
- **Security maintainers** handle private vulnerability reports.
- **Release maintainers** may approve protected staging and production environments.
- **Site moderators** review reports and evidence.
- **Site administrators** manage site roles and high-risk operations.

Community rank is only a record of approved site activity. It grants no staff, repository, release, or production permission.

Repository maintainership changes should be public unless early disclosure creates a security risk. Website staff changes remain in private application and audit records. Staff do not have to publish contact details or application answers.

## Site staff

An active member with both Discord and email linked may apply from the account page. Review covers judgment, privacy awareness, consistency, communication, conflicts, and whether another moderator is actually needed.

A moderator may begin review or reject an application. Only an administrator may accept it and grant `moderator`. The applicant may withdraw while the application is pending or under review. After 90 days without applicant or reviewer activity, an active application expires and its answers and review notes are erased. [PRIVACY.md](docs/PRIVACY.md#moderator-applications) has the full retention rule.

There is no administrator application. An administrator may promote a proven moderator when more operational coverage is needed and the step-up checks pass. Popularity, rank, donations, post count, and code contributions never create a right to staff access.

Staff access may be suspended immediately after compromise, abuse, or a serious privacy risk. The decision is then reviewed and recorded.

## Project decisions

Routine work uses pull-request review. Changes to auth, privacy, evidence, reputation, moderation, licensing, governance, or deployment need:

1. an issue describing the problem and realistic options;
2. a focused pull request with tests and docs;
3. the relevant CODEOWNERS review;
4. a written decision in the issue or pull request.

Security fixes may be prepared privately and published after the coordinated release.

Maintainers disclose conflicts and step away when they cannot be impartial. Private reports and vulnerabilities stay private. The author of a sensitive release must not be its only approver.

Inactive maintainers may move to emeritus status after notice and a reasonable response window. Compromised or abusive access may be suspended at once.

## Releases and policy changes

Releases come from reviewed tags and include checksums, an SPDX SBOM, and provenance. Production uses that reviewed artifact, not a local build.

Governance changes follow the decision process above. Existing contributions cannot be relicensed without the permission required by law and the current license.

[FREE_ACCESS.md](docs/FREE_ACCESS.md) contains the official site's funding promise. The AGPL governs software rights; it does not create a charity or tax-exempt organization.
