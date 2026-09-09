import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";
import {
  LIFECYCLE_CHECKS,
  createEvidence,
  validatePackageManifest,
  validateObservations,
  workflowUrl,
} from "../scripts/release-evidence.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function observations() {
  return {
    tested_at: "2026-08-06T12:00:00Z",
    platforms: ["windows-x86_64", "linux-x86_64"],
    lifecycle: Object.fromEntries(LIFECYCLE_CHECKS.map((check) => [check, {
      status: "passed",
      observation: `Manual host observation for ${check}.`,
    }])),
  };
}

test("derives an Actions URL only from GitHub run environment", () => {
  assert.equal(workflowUrl({
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "ManuelZierl/kestral-chat-export",
    GITHUB_RUN_ID: "12345",
  }), "https://github.com/ManuelZierl/kestral-chat-export/actions/runs/12345");
  assert.throws(() => workflowUrl({ GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "1" }), /GITHUB_SERVER_URL/);
});

test("rejects missing, unknown, malformed, and non-passed observations", () => {
  const value = observations();
  assert.throws(() => validateObservations({ ...value, unexpected: true }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, extra: { status: "passed", observation: "x" } } }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, activation: { status: "failed", observation: "x" } } }), /must be 'passed'/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, restart: undefined } }), /must be an object/);
});

test("rejects malformed host versions and package manifests", () => {
  assert.throws(() => validatePackageManifest({
    format_version: 1,
    id: "com.example.app",
    version: "0.1.0",
    display_name: "Example",
    description: "Example app",
    min_host_version: "0.1.0",
    manifest: {},
    backend: { kind: "not-supported" },
    data: { kind: "none" },
    integrity: { algorithm: "sha256", assets: {} },
  }, { version: "0.1.0" }, "com.example.app"), /backend\.kind is unsupported/);
});

test("release workflow pins the source commit and refuses overwrite or generated drift", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-evidence.yml", import.meta.url), "utf8");
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /source_commit:/);
  assert.match(workflow, /ref: \$\{\{ inputs\.source_commit \}\}/);
  assert.match(workflow, /test "\$head" = "\$GITHUB_SHA"/);
  assert.match(workflow, /tauri_tested:/);
  assert.match(workflow, /git diff --exit-code -- dist/);
  assert.match(workflow, /git status --porcelain --untracked-files=all/);
  assert.match(workflow, /gh release view \"\$RELEASE_TAG\"/);
  assert.match(workflow, /git ls-remote --exit-code --refs origin/);
  assert.doesNotMatch(workflow, /--clobber/);
});

test("creates schema-shaped evidence only for a clean, identity-matching package", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestral-release-evidence-"));
  await mkdir(join(root, "dist", "ui"), { recursive: true });
  await writeFile(join(root, "dist", "ui", "index.html"), "<!doctype html>\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "kestral-chat-export", version: "0.1.2" }));
  const assetDigest = `sha256-${createHash("sha256").update("<!doctype html>\n").digest("hex")}`;
  await writeFile(join(root, "dist", "app.json"), JSON.stringify({
    format_version: 1,
    id: "com.ma-zierl.kestral-chat-export",
    version: "0.1.2",
    display_name: "Chat Export",
    description: "Example export app",
    min_host_version: "0.1.0-alpha.1",
    backend: { kind: "mcp-stdio", authority_mode: "unsandboxed", command: "chat-export" },
    data: { kind: "none" },
    manifest: {},
    integrity: { algorithm: "sha256", assets: { "ui/index.html": assetDigest } },
  }));
  const digest = await packageDigest(join(root, "dist"));
  const context = {
    root,
    observations: observations(),
    expectedPackageDigest: digest,
    hostVersion: "0.1.0-alpha.1",
    hostCommit: HEAD,
    env: {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "ManuelZierl/kestral-chat-export",
      GITHUB_RUN_ID: "12345",
      GITHUB_SHA: HEAD,
      EXPECTED_APP_ID: "com.ma-zierl.kestral-chat-export",
      EXPECTED_REPOSITORY: "https://github.com/ManuelZierl/kestral-chat-export",
    },
    git: (args) => args[0] === "rev-parse" ? HEAD : "",
    expectedAppId: "com.ma-zierl.kestral-chat-export",
    expectedRepository: "https://github.com/ManuelZierl/kestral-chat-export",
  };
  const evidence = await createEvidence(context);
  assert.deepEqual(evidence.app, { id: "com.ma-zierl.kestral-chat-export", version: "0.1.2" });
  assert.equal(evidence.source.clean, true);
  assert.equal(evidence.package.digest, digest);
  assert.equal(evidence.run.workflow_url, "https://github.com/ManuelZierl/kestral-chat-export/actions/runs/12345");
  assert.deepEqual(evidence.extension_contributions, []);
  await assert.rejects(() => createEvidence({ ...context, expectedPackageDigest: "sha256-0000000000000000000000000000000000000000000000000000000000000000" }), /package digest mismatch/);
  await assert.rejects(() => createEvidence({ ...context, env: { ...context.env, GITHUB_SHA: "fedcba9876543210fedcba9876543210fedcba98" } }), /does not match source HEAD/);
  await assert.rejects(() => createEvidence({ ...context, git: (args) => args[0] === "rev-parse" ? HEAD : " M package.json" }), /source checkout is not clean/);
  await assert.rejects(() => createEvidence({ ...context, hostVersion: "not-a-version" }), /host version must be strict semver/);
  await assert.rejects(() => createEvidence({ ...context, hostCommit: "not-a-commit" }), /host commit must be a lowercase full Git commit/);
  await assert.rejects(() => createEvidence({ ...context, expectedAppId: "not-an-app-id" }), /expected app ID must be a valid reverse-DNS app ID/);
  await assert.rejects(() => createEvidence({ ...context, expectedPackageDigest: digest, env: { ...context.env }, observations: { ...observations(), lifecycle: { ...observations().lifecycle, restart: { status: "passed", observation: "" } } } }), /observation must be a non-empty string/);
  await writeFile(join(root, "dist", "ui", "index.html"), "tampered\n");
  const tamperedDigest = await packageDigest(join(root, "dist"));
  await assert.rejects(() => createEvidence({ ...context, expectedPackageDigest: tamperedDigest }), /integrity checksum mismatch/);
});

test("rejects impossible lifecycle dates rather than normalizing them", () => {
  for (const tested_at of ["2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-08-06T24:00:00Z", "1900-02-29T12:00:00Z", "2026-02-30T12:00:00+02:00", "2026-08-06T12:60:00Z"]) {
    assert.throws(() => validateObservations({ ...observations(), tested_at }), /ISO date-time/);
  }
  for (const tested_at of ["2024-02-29T23:59:59.123Z", "2000-02-29T12:00:00Z", "2026-08-06T00:00:00+02:00", "2026-08-06T23:59:59-02:00"]) {
    assert.equal(validateObservations({ ...observations(), tested_at }).tested_at, tested_at);
  }
});

test("rejects blank lifecycle observations and platforms", () => {
  const value = observations();
  assert.throws(() => validateObservations({
    ...value, lifecycle: { ...value.lifecycle, activation: { status: "passed", observation: " \n\t " } },
  }), /non-empty string/);
  assert.throws(() => validateObservations({ ...value, platforms: ["   "] }), /non-empty strings/);
});
