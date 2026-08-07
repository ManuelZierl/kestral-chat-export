import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDigest } from "../scripts/package-digest.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function buildOnce() {
  await rm(join(root, "dist"), { recursive: true, force: true });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["build.mjs"], { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))));
  });
  return packageDigest(join(root, "dist"));
}

const first = await buildOnce();
const second = await buildOnce();
if (first !== second) {
  console.error(`non-reproducible package digest: ${first} != ${second}`);
  process.exit(1);
}
console.log("reproducible package");
console.log(first);
