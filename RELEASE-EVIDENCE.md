# Lifecycle Evidence

This repository publishes the format-1 evidence document required for a
promoted external Kestral app. The document is an attestation produced after a
real manual host run. The workflow validates the attestation and package
identity; it does not run Kestral or Tauri tests. Dispatch requires the exact
app `source_commit` and an explicit `tauri_tested: true` manual attestation.

## Two-Commit Boundary

Use the clean app source commit that produced `dist/` as the evidence source
commit. The Kestral release record is filled in by a later metadata-only core
commit, so the core commit that was tested is not changed to record its own
hash or evidence URL. Do not combine those two core commits.

## Manual Observations

Before dispatching **Release evidence**, run the lifecycle checks against the
exact package, lowercase 40-hex app `source_commit`, and exact Kestral host
commit named in the dispatch inputs. Set `tauri_tested` to `true` after the
real Tauri run. Keep the workflow's `observations` input as this exact JSON
shape. Every check is required, must have `status: "passed"`, and must
describe what the retained run proved:

```json
{
  "tested_at": "2026-08-06T12:00:00Z",
  "platforms": ["windows-x86_64", "linux-x86_64"],
  "lifecycle": {
    "package_inspection": { "status": "passed", "observation": "..." },
    "permission_denial": { "status": "passed", "observation": "..." },
    "activation": { "status": "passed", "observation": "..." },
    "representative_action": { "status": "passed", "observation": "..." },
    "restart": { "status": "passed", "observation": "..." },
    "update_data_preservation": { "status": "passed", "observation": "..." },
    "disable_enable": { "status": "passed", "observation": "..." },
    "keep_data_uninstall": { "status": "passed", "observation": "..." },
    "purge_data_uninstall": { "status": "passed", "observation": "..." }
  }
}
```

The observations must cover:

1. Package inspection without executing package code.
2. Permission denial and absence of a denied grant.
3. Activation and the expected Chat action.
4. One representative export through Kestral's normal action path.
5. Restart with activation and state retained.
6. Update with app-owned and host-owned state preserved or explicitly migrated.
7. Disable and re-enable with authority absent while disabled.
8. Keep-data uninstall, reinstall, and retained data.
9. Purge-data uninstall with package data, config, and secrets absent.

The input rejects unknown fields, missing checks, duplicate platforms, malformed
timestamps (including impossible calendar dates), failed statuses, and blank
observations or platform names. `workflow_url` is not an
input: the generator derives it from `GITHUB_SERVER_URL`,
`GITHUB_REPOSITORY`, and `GITHUB_RUN_ID`.

## Dispatch Gates

The workflow checks out Kestral's public schema at pinned commit
`82a983a268911e7a1958b4c6eab06dde334070b1` into `.kestral-contract`; it never
uses a parent-relative schema path. It verifies the clean checked-out app HEAD,
app ID and version, the expected canonical package digest, extension
contributions, and the generated evidence shape. The package CI and this
workflow also rebuild `dist/` and require no generated diff.

Dispatch with a new `release_tag` matching the workflow's conservative syntax.
The tag must not already exist as either a GitHub release or remote
`refs/tags/<tag>`. Publication
creates a new GitHub release and uploads an asset whose name includes the app
version and source commit without requesting overwrite. A GitHub release URL is
not treated as immutable: Kestral core re-downloads the evidence and compares
its bytes with the SHA-256 pinned in the core promotion record. Start the
dispatch from a ref whose `GITHUB_SHA` matches `source_commit`; a mismatch is
rejected.

The evidence asset is suitable for pinning from Kestral's release record by its
release URL and SHA-256 bytes. It does not bundle the app or grant the app
special authority.
