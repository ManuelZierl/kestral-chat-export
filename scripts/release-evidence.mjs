import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDigest } from "./package-digest.mjs";

export const LIFECYCLE_CHECKS = [
  "package_inspection",
  "permission_denial",
  "activation",
  "representative_action",
  "restart",
  "update_data_preservation",
  "disable_enable",
  "keep_data_uninstall",
  "purge_data_uninstall",
];

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256-[0-9a-f]{64}$/;
const REPOSITORY = /^https:\/\/github\.com\/[^/]+\/[^/]+$/;
const APP_ID = /^(?!mcp-)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const BACKEND_KINDS = new Set(["none", "mcp-stdio", "mcp-streamable-http", "executable", "agent-worker"]);
const DATA_KINDS = new Set(["none", "versioned", "host-managed"]);
const PACKAGE_PATH = /^(?:ui|backend)\/[^\\:*?"<>|]+$/;

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields differ: expected ${wanted.join(", ")}; found ${actual.join(", ")}`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${label} must be a lowercase full Git commit`);
}

function semver(value, label) {
  if (typeof value !== "string" || !SEMVER.test(value)) throw new Error(`${label} must be strict semver`);
}

function validateDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO date-time`);
  // Date.parse accepts impossible calendar dates and 24:00 by rolling them
  // forward. An attestation must describe the supplied date, not a repair.
  const date = value.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || Number(value.slice(11, 13)) > 23) {
    throw new Error(`${label} must be an ISO date-time`);
  }
}

function validateLifecycle(lifecycle) {
  exactKeys(lifecycle, LIFECYCLE_CHECKS, "observations.lifecycle");
  for (const check of LIFECYCLE_CHECKS) {
    const result = lifecycle[check];
    exactKeys(result, ["status", "observation"], `observations.lifecycle.${check}`);
    if (result.status !== "passed") throw new Error(`observations.lifecycle.${check}.status must be 'passed'`);
    nonEmpty(result.observation, `observations.lifecycle.${check}.observation`);
  }
}

export function validatePackageManifest(manifest, packageMetadata, expectedAppId) {
  object(manifest, "dist/app.json");
  object(packageMetadata, "package.json");
  if (manifest.format_version !== 1) throw new Error("dist/app.json format_version must be 1");
  if (typeof expectedAppId !== "string" || !APP_ID.test(expectedAppId)) throw new Error("expected app ID must be a valid reverse-DNS app ID");
  if (manifest.id !== expectedAppId) throw new Error("dist/app.json app identity does not match expected app ID");
  semver(manifest.version, "dist/app.json version");
  if (typeof packageMetadata.version !== "string") throw new Error("package.json version must be a string");
  semver(packageMetadata.version, "package.json version");
  if (manifest.version !== packageMetadata.version) throw new Error("dist/app.json version does not match package.json");
  nonEmpty(manifest.display_name, "dist/app.json display_name");
  nonEmpty(manifest.description, "dist/app.json description");
  semver(manifest.min_host_version, "dist/app.json min_host_version");
  object(manifest.manifest, "dist/app.json manifest");
  object(manifest.backend, "dist/app.json backend");
  if (!BACKEND_KINDS.has(manifest.backend.kind)) throw new Error("dist/app.json backend.kind is unsupported");
  object(manifest.data, "dist/app.json data");
  if (!DATA_KINDS.has(manifest.data.kind)) throw new Error("dist/app.json data.kind is unsupported");
  object(manifest.integrity, "dist/app.json integrity");
  if (manifest.integrity.algorithm !== "sha256") throw new Error("dist/app.json integrity.algorithm must be sha256");
  object(manifest.integrity.assets, "dist/app.json integrity.assets");
  return manifest;
}

export function validateObservations(value) {
  exactKeys(value, ["tested_at", "platforms", "lifecycle"], "observations");
  validateDate(value.tested_at, "observations.tested_at");
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) throw new Error("observations.platforms must contain at least one platform");
  if (value.platforms.some((platform) => typeof platform !== "string" || platform.trim().length === 0)) throw new Error("observations.platforms must contain non-empty strings");
  if (new Set(value.platforms).size !== value.platforms.length) throw new Error("observations.platforms must not contain duplicates");
  validateLifecycle(value.lifecycle);
  return value;
}

export function workflowUrl(env) {
  const server = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (server !== "https://github.com") throw new Error("GITHUB_SERVER_URL must be https://github.com");
  if (typeof repository !== "string" || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/repository");
  if (typeof runId !== "string" || !/^\d+$/.test(runId)) throw new Error("GITHUB_RUN_ID must be a numeric workflow run ID");
  return `${server}/${repository}/actions/runs/${runId}`;
}

function gitCommands(root) {
  return (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function extensionContributions(manifest) {
  const contributions = manifest?.manifest?.extension_contributions;
  if (contributions === undefined) return [];
  if (!Array.isArray(contributions)) throw new Error("dist/app.json manifest.extension_contributions must be an array");
  return contributions.map((contribution, index) => {
    exactKeys(contribution, ["target_app", "extension_point", "contract_version", "surface"], `dist.app.json extension_contributions[${index}]`);
    nonEmpty(contribution.target_app, `dist.app.json extension_contributions[${index}].target_app`);
    nonEmpty(contribution.extension_point, `dist.app.json extension_contributions[${index}].extension_point`);
    if (!Number.isSafeInteger(contribution.contract_version) || contribution.contract_version < 1) throw new Error(`dist.app.json extension_contributions[${index}].contract_version must be positive`);
    return {
      target_app: contribution.target_app,
      extension_point: contribution.extension_point,
      contract_version: contribution.contract_version,
    };
  });
}

async function validateAssetDigests(packageRoot, manifest) {
  for (const [path, expected] of Object.entries(manifest.integrity.assets)) {
    if (!PACKAGE_PATH.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`dist/app.json integrity asset '${path}' has an unsafe package path`);
    }
    if (typeof expected !== "string" || !SHA256.test(expected)) throw new Error(`dist/app.json integrity asset '${path}' must be a sha256 digest`);
    const bytes = await readFile(join(packageRoot, ...path.split("/")));
    const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== expected) throw new Error(`integrity checksum mismatch for '${path}'`);
  }
}

export async function createEvidence({
  root,
  observations,
  expectedPackageDigest,
  expectedAppId,
  expectedRepository,
  hostVersion,
  hostCommit,
  env = process.env,
  git = gitCommands(root),
}) {
  validateObservations(observations);
  semver(hostVersion, "host version");
  if (typeof expectedRepository !== "string" || !REPOSITORY.test(expectedRepository)) throw new Error("expected repository must be a canonical GitHub HTTPS repository");
  commit(hostCommit, "host commit");
  if (typeof expectedPackageDigest !== "string" || !SHA256.test(expectedPackageDigest)) throw new Error("expected package digest must be a sha256 digest");

  const head = git(["rev-parse", "HEAD"]);
  commit(head, "source HEAD");
  if (env.GITHUB_SHA !== head) throw new Error(`GITHUB_SHA ${env.GITHUB_SHA || "<missing>"} does not match source HEAD ${head}`);
  if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") throw new Error("source checkout is not clean");

  const repository = `https://github.com/${env.GITHUB_REPOSITORY || ""}`;
  if (!REPOSITORY.test(repository)) throw new Error("source repository is not a canonical GitHub HTTPS repository");
  if (repository !== expectedRepository) throw new Error("source repository does not match expected repository");
  const packageRoot = join(root, "dist");
  const [packageManifest, packageMetadata] = await Promise.all([
    readFile(join(packageRoot, "app.json"), "utf8").then(JSON.parse),
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
  ]);
  validatePackageManifest(packageManifest, packageMetadata, expectedAppId);
  const actualDigest = await packageDigest(packageRoot);
  await validateAssetDigests(packageRoot, packageManifest);
  if (actualDigest !== expectedPackageDigest) throw new Error(`package digest mismatch: expected ${expectedPackageDigest}, got ${actualDigest}`);

  return {
    format_version: 1,
    app: { id: packageManifest.id, version: packageManifest.version },
    source: { repository, commit: head, clean: true },
    package: { digest: actualDigest },
    host: { version: hostVersion, commit: hostCommit },
    run: { workflow_url: workflowUrl(env), tested_at: observations.tested_at, platforms: observations.platforms },
    extension_contributions: extensionContributions(packageManifest),
    lifecycle: observations.lifecycle,
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function readObservations(args) {
  const file = optionValue(args, "--observations-file") || optionValue(args, "--observations");
  const envName = optionValue(args, "--observations-env");
  const inline = optionValue(args, "--observations-json") || (envName && process.env[envName]);
  if (!file && !inline) throw new Error("required manual observations are missing");
  if (file && inline) throw new Error("provide one observations file or observations JSON value");
  const raw = file ? await readFile(resolve(file), "utf8") : inline;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`manual observations are not valid JSON: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const observations = await readObservations(args);
  const root = resolve(optionValue(args, "--source") || dirname(dirname(fileURLToPath(import.meta.url))));
  const expectedPackageDigest = optionValue(args, "--expected-package-digest") || process.env.EXPECTED_PACKAGE_DIGEST;
  const expectedAppId = optionValue(args, "--expected-app-id") || process.env.EXPECTED_APP_ID;
  const expectedRepository = optionValue(args, "--expected-repository") || process.env.EXPECTED_REPOSITORY;
  const hostVersion = optionValue(args, "--host-version") || process.env.HOST_VERSION;
  const hostCommit = optionValue(args, "--host-commit") || process.env.HOST_COMMIT;
  const output = optionValue(args, "--output") || process.env.RELEASE_EVIDENCE_OUTPUT;
  if (!expectedPackageDigest || !expectedAppId || !expectedRepository || !hostVersion || !hostCommit || !output) throw new Error("expected app ID, repository, package digest, host version, host commit, and output are required");
  const evidence = await createEvidence({ root, observations, expectedPackageDigest, expectedAppId, expectedRepository, hostVersion, hostCommit });
  await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(`wrote ${resolve(output)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
