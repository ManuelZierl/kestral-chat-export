import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { compile } from "svelte/compiler";
import {
  APP_ID,
  CHAT_APP_ID,
  THREAD_ACTIONS_CONTRACT,
  VERSION,
} from "./src/contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const dist = join(here, "dist");

const sveltePlugin = {
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const { js, warnings } = compile(source, {
        filename: args.path,
        generate: "client",
        css: "injected",
        runes: true,
      });
      for (const warning of warnings) console.warn(`svelte: ${warning.message}`);
      return { contents: js.code, loader: "js" };
    });
  },
};

async function bundle(entry, options) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "warning",
    ...options,
  });
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll("\\\\", "/");
    const marker = "node_modules/";
    const at = normalized.lastIndexOf(marker);
    if (at < 0) continue;
    const parts = normalized.slice(at + marker.length).split("/");
    packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  return { text: result.outputFiles[0].text, packages };
}

const sha256 = (content) => `sha256-${createHash("sha256").update(content).digest("hex")}`;

async function thirdPartyNotices(packageNames) {
  const packages = [];
  for (const name of [...packageNames].sort()) {
    const directory = join(here, "node_modules", ...name.split("/"));
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    let licenseText = null;
    for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "COPYING"]) {
      try {
        licenseText = await readFile(join(directory, candidate), "utf8");
        break;
      } catch {
        // Try the next conventional license filename.
      }
    }
    if (!licenseText) throw new Error(`runtime dependency ${name}@${metadata.version} has no readable license file`);
    const license = typeof metadata.license === "string"
      ? metadata.license
      : metadata.licenses?.map((entry) => entry.type).join(", ") || "unknown";
    packages.push({ name, version: metadata.version, license, licenseText: licenseText.trim() });
  }
  const sections = packages.map((dependency) =>
    `${dependency.name}@${dependency.version}\nSPDX license: ${dependency.license}\n\n${dependency.licenseText}`,
  );
  return `Chat Export third-party notices\n\nThe following dependencies are bundled in the installable package payload.\n\n${sections.join(`\n\n${"=".repeat(72)}\n\n`)}\n`;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, "ui"), { recursive: true });

  const [surfaceBundle, icon, appLicense] = await Promise.all([
    bundle(join(src, "surface", "main.ts"), {
      format: "iife",
      platform: "browser",
      target: "es2022",
      plugins: [sveltePlugin],
    }),
    readFile(join(src, "icon.svg")),
    readFile(join(here, "LICENSE")),
  ]);
  const notices = await thirdPartyNotices(surfaceBundle.packages);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chat Export</title>
</head>
<body></body>
<script>${surfaceBundle.text.replace(/<\/script/gi, "<\\/script")}</script>
</html>
`;

  const manifest = {
    format_version: 1,
    id: APP_ID,
    version: VERSION,
    display_name: "Chat Export",
    description:
      "Adds an action inside Chat for downloading the conversation you're viewing as Markdown, plain text, JSON, or safe HTML.",
    publisher: { name: "Kestral reference apps" },
    license: "MIT",
    icon: "ui/icon.svg",
    min_host_version: "0.1.0-alpha.1",
    manifest: {
      capabilities: [],
      surfaces: [
        {
          name: "thread-export",
          kind: "card",
          title: "Export conversation",
          description: "Download the conversation you're viewing in a portable format.",
          intents: [{ provider: CHAT_APP_ID, capability: "chat.read_thread" }],
          ui: { entry: "ui/index.html" },
        },
      ],
      extension_contributions: [
        {
          target_app: CHAT_APP_ID,
          extension_point: "thread-actions",
          contract_version: THREAD_ACTIONS_CONTRACT,
          surface: "thread-export",
        },
      ],
      grant_requests: [
        {
          scope: {
            kind: "exact-capability",
            provider: CHAT_APP_ID,
            capability: "chat.read_thread",
          },
          data_scope: { kind: "all-resources" },
          condition: "silent",
          reason: "Read the conversation shown in Chat when you use its export card. This permission covers all current and future conversations.",
          duration: { kind: "non-expiring" },
        },
      ],
    },
    backend: { kind: "none" },
    data: { kind: "none" },
    integrity: {
      algorithm: "sha256",
      assets: {
      "ui/index.html": sha256(html),
      "ui/icon.svg": sha256(icon),
      "ui/LICENSE": sha256(appLicense),
      "ui/THIRD-PARTY-NOTICES.txt": sha256(notices),
      },
    },
  };

  await Promise.all([
    writeFile(join(dist, "ui", "index.html"), html),
    writeFile(join(dist, "ui", "icon.svg"), icon),
    writeFile(join(dist, "ui", "LICENSE"), appLicense),
    writeFile(join(dist, "ui", "THIRD-PARTY-NOTICES.txt"), notices),
    writeFile(join(dist, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  console.log("Built Chat Export package -> dist/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
