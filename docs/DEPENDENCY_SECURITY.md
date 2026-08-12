# Dependency security

The production dependency gate is:

```bash
npm audit --omit=dev --audit-level=high
```

CI requires it. The complete graph gets a separate review. A build-only advisory without a compatible fix stays listed below with the actual exposure and current decision.

## Open build-tool advisories

Reviewed on 2026-08-10:

| Dependency path                              | Advisory                                                                                                                                           | Exposure in this repository                                                                  | Current decision                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-kit` → `@esbuild-kit/*` → `esbuild` | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)                                                                           | Local schema tooling only. It is not shipped in the Worker.                                  | Keep the development server bound to localhost and update when Drizzle publishes a compatible fix. npm currently proposes an older, incompatible Drizzle Kit release.                   |
| `vinext` → `image-size`                      | [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr), [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) | Build-time inspection of repository-owned assets. User evidence never passes through Vinext. | Keep uploaded evidence in the separate validated Cloudflare pipeline. Upgrade as soon as Vinext accepts a patched `image-size`; no patched registry release exists at this review date. |

Recheck an entry when the tool changes, starts reading untrusted files, or becomes part of the deployed Worker. Dependabot and the release audit stay enabled.
