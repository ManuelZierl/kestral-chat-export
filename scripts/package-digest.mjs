import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_JSON = "app.json";
const PACKAGE_PATH = /^(?:ui|backend)\/[^\\:*?"<>|]+$/;

function fail(message) {
  throw new Error(message);
}

function normalizePackagePath(value) {
  if (typeof value !== "string" || !PACKAGE_PATH.test(value) || value.includes("/./") || value.includes("/../") || value.endsWith("/.") || value.endsWith("/..")) {
    fail(`unsafe package path '${value}'`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail(`unsafe package path '${value}'`);
  return value;
}

async function regularFile(root, rel) {
  const path = join(root, ...rel.split("/"));
  const stats = await lstat(path).catch((error) => fail(`inspect package file '${rel}' failed: ${error.message}`));
  if (stats.isSymbolicLink() || !stats.isFile()) fail(`package entry '${rel}' is not a regular file`);
  return path;
}

async function walk(root, current, files) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) fail(`package symlinks are unsupported: ${path}`);
    if (entry.isDirectory()) {
      await walk(root, path, files);
    } else if (entry.isFile()) {
      if (rel === "app.signature.json") continue;
      const normalized = rel === APP_JSON ? APP_JSON : normalizePackagePath(rel);
      if (files.has(normalized)) fail(`duplicate normalized package path '${normalized}'`);
      files.add(normalized);
    } else {
      fail(`unsupported package file type: ${path}`);
    }
  }
}

async function declaredPaths(root) {
  const manifest = JSON.parse(await readFile(await regularFile(root, APP_JSON), "utf8"));
  if (manifest?.integrity?.algorithm !== "sha256" || manifest.integrity.assets === null || typeof manifest.integrity.assets !== "object" || Array.isArray(manifest.integrity.assets)) {
    fail("app.json integrity must declare sha256 assets");
  }
  const paths = new Set([APP_JSON]);
  const folded = new Set([APP_JSON.toLowerCase()]);
  for (const value of Object.keys(manifest.integrity.assets)) {
    const path = normalizePackagePath(value);
    if (path !== value || paths.has(path)) fail(`duplicate normalized package path '${value}'`);
    if (folded.has(path.toLowerCase())) fail(`case-colliding package path '${value}'`);
    paths.add(path);
    folded.add(path.toLowerCase());
  }
  return paths;
}

async function packageFiles(root, declared) {
  const actual = new Set();
  await walk(root, root, actual);
  actual.delete("app.signature.json");
  const extra = [...actual].filter((path) => !declared.has(path));
  const missing = [...declared].filter((path) => !actual.has(path));
  if (extra.length || missing.length) {
    fail(`package file declaration mismatch; extra=${JSON.stringify(extra.sort())}, missing=${JSON.stringify(missing.sort())}`);
  }
  return [...declared].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export async function packageDigest(packageDirectory) {
  const root = resolve(packageDirectory);
  const declared = await declaredPaths(root);
  const files = await packageFiles(root, declared);
  const hash = createHash("sha256");
  for (const rel of files) {
    const path = await regularFile(root, rel);
    const bytes = await readFile(path);
    const pathBytes = Buffer.from(rel, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(pathBytes.length));
    hash.update(length);
    hash.update(pathBytes);
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256-${hash.digest("hex")}`;
}

async function main() {
  const packageIndex = process.argv.indexOf("--package");
  const packageDirectory = packageIndex === -1
    ? join(dirname(dirname(fileURLToPath(import.meta.url))), "dist")
    : process.argv[packageIndex + 1];
  if (!packageDirectory) fail("usage: node scripts/package-digest.mjs [--package <dist-directory>]");
  console.log(await packageDigest(packageDirectory));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
