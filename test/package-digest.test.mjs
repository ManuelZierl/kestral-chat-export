import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";

test("matches an expected digest for the checked-in package when requested", async () => {
  if (!process.env.EXPECTED_PACKAGE_DIGEST) return;
  assert.equal(
    await packageDigest(fileURLToPath(new URL("../dist/", import.meta.url))),
    process.env.EXPECTED_PACKAGE_DIGEST,
  );
});

test("matches the Kestral canonical package digest stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestral-package-digest-"));
  await mkdir(join(root, "ui"));
  await writeFile(join(root, "ui", "a.txt"), "hello\n");
  await writeFile(join(root, "app.json"), JSON.stringify({ integrity: { algorithm: "sha256", assets: { "ui/a.txt": "sha256-2d6944241362c8000034a6b330bbea45fd89b340fac699e183c81064c926931f" } } }));
  assert.equal(await packageDigest(root), "sha256-635da8f219b0d0550a1ba867f3012f84e8983fed82f06d986bb7e9dd4bdcb065");
});

test("allows the detached signature carrier but rejects undeclared payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestral-package-digest-"));
  await mkdir(join(root, "ui"));
  await writeFile(join(root, "ui", "a.txt"), "a");
  await writeFile(join(root, "ui", "extra.txt"), "not declared");
  await writeFile(join(root, "app.signature.json"), "{}");
  await writeFile(join(root, "app.json"), JSON.stringify({ integrity: { algorithm: "sha256", assets: { "ui/a.txt": "sha256-ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" } } }));
  await assert.rejects(() => packageDigest(root), /declaration mismatch/);
});
