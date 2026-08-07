import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APP_ID,
  CHAT_APP_ID,
  THREAD_ACTIONS_CONTRACT,
  VERSION,
} from "../src/contracts.mjs";

const packageRoot = new URL("../dist/", import.meta.url);

test("package contributes only an inline Chat action", async () => {
  const manifest = JSON.parse(await readFile(new URL("app.json", packageRoot), "utf8"));
  assert.equal(manifest.id, APP_ID);
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.backend, { kind: "none" });
  assert.deepEqual(manifest.data, { kind: "none" });
  assert.deepEqual(manifest.manifest.capabilities, []);
  assert.deepEqual(manifest.manifest.grant_requests, [
    {
      scope: { kind: "exact-capability", provider: CHAT_APP_ID, capability: "chat.read_thread" },
      data_scope: { kind: "all-resources" },
      condition: "silent",
      reason: "Read the conversation shown in Chat when you use its export card. This permission covers all current and future conversations.",
      duration: { kind: "non-expiring" },
    },
  ]);
  assert.equal(manifest.manifest.surfaces.length, 1);
  assert.equal(manifest.manifest.surfaces[0].kind, "card");
  assert.deepEqual(manifest.manifest.surfaces[0].intents, [
    { provider: CHAT_APP_ID, capability: "chat.read_thread" },
  ]);
  assert.deepEqual(manifest.manifest.extension_contributions, [{
    target_app: CHAT_APP_ID,
    extension_point: "thread-actions",
    contract_version: THREAD_ACTIONS_CONTRACT,
    surface: "thread-export",
  }]);
  assert.equal(manifest.manifest.artifact_types, undefined);
  assert.equal(manifest.manifest.config_declarations, undefined);
  assert.deepEqual(Object.keys(manifest.integrity.assets).sort(), [
    "ui/LICENSE",
    "ui/THIRD-PARTY-NOTICES.txt",
    "ui/icon.svg",
    "ui/index.html",
  ]);
  for (const [path, expected] of Object.entries(manifest.integrity.assets)) {
    const bytes = await readFile(new URL(path, packageRoot));
    assert.equal(`sha256-${createHash("sha256").update(bytes).digest("hex")}`, expected);
  }
});

test("ships app and bundled-runtime notices", async () => {
  const license = await readFile(new URL("ui/LICENSE", packageRoot), "utf8");
  const notices = await readFile(new URL("ui/THIRD-PARTY-NOTICES.txt", packageRoot), "utf8");
  assert.match(license, /MIT License/);
  assert.match(notices, /Chat Export third-party notices/);
  assert.match(notices, /svelte@/);
});

test("inline surface is bounded, theme-native, and resource-scoped", async () => {
  const html = await readFile(new URL("ui/index.html", packageRoot), "utf8");
  assert.match(html, /name="viewport"/);
  assert.match(html, /chat\.read_thread/);
  assert.match(html, /resource_ids/);
  assert.match(html, /invokeScoped/);
  assert.match(html, /Download /);
  assert.match(html, /What gets exported\?/);
  assert.match(html, /Hidden prompts and model reasoning are not included/);
  assert.match(html, /createObjectURL/);
  assert.match(html, /var\(--color-text\)/);
  assert.match(html, /max-width:\s*24em/);
  assert.doesNotMatch(html, /__TAURI__|api[_-]?key|backend\/server/i);
  assert.doesNotMatch(html, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
