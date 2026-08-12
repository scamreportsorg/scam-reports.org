# Contributing

Thanks for helping. A small change with a clear reason and a useful test is much easier to review than a broad rewrite.

## Keep cases off GitHub

Issues, discussions, pull requests, screenshots, and commit messages must not contain:

- accusations, reports, or appeals;
- evidence files or screenshots;
- Discord IDs, email or IP addresses, or other personal data;
- staff applications, correspondence, or staff identity details;
- details of an unfixed vulnerability.

Use the website for reports and appeals. Use the private route in [SECURITY.md](SECURITY.md) for vulnerabilities.

Fixtures and screenshots must be obviously fictional. Do not add real case material, copied forum assets, private files, production IDs, or credentials.

## Usual workflow

1. Fork the repository and make a focused branch.
2. Install exactly what the lockfile specifies with `npm ci`.
3. Make the change and cover the behavior you touched.
4. Run `npm run typecheck`, `npm run lint`, and `npm test`.
5. Run `node scripts/audit-publication.mjs` and `node scripts/check-licenses.mjs`.
6. Open a pull request with the template.

Before a release PR, run the complete `npm run release:check` gate.

## What reviewers check

- Server code still owns authorization and moderation decisions.
- Auth, Turnstile, evidence processing, and publication fail closed.
- Request data, uploads, OAuth results, headers, URLs, database rows, webhooks, and provider replies stay untrusted.
- Original evidence and storage keys cannot reach public responses.
- A schema change has a numbered migration and upgrade coverage.
- Tests and public policy match the behavior.
- The forum still looks like this project rather than a generic dashboard.

Authentication, authorization, evidence, migration, and deployment work needs the relevant CODEOWNERS review.

## Sign-off and licensing

The project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/), not a contributor license agreement. Sign every non-merge commit:

```bash
git commit --signoff
```

The `Signed-off-by: Name <email>` trailer says you have the right to submit the work under the project license. CI rejects unsigned commits.

Unless a file says otherwise, contributions are `AGPL-3.0-or-later`. Only copy code, media, or text when its license is compatible and all attribution is present. Mention new third-party material in the pull request and update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when needed.

A good pull request explains the result and any security or privacy effect, links an issue for a material behavior change, avoids drive-by formatting, uses synthetic screenshots, and updates tests and docs. Changes that expose personal data, enable harassment, or weaken moderation controls will be closed.
