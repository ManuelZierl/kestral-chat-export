# Chat Export

Chat Export adds one compact export action to Kestral's built-in Chat. It has no
standalone screen, native backend, app capability, transcript store, or network
access.

## Use

1. Build this repository and open **Apps > Install an app > Local folder**.
2. Choose `dist/`, select **Review app**, and explicitly select Chat Export's
   broad `chat.read_thread` request. It covers all current and future
   conversations and starts unchecked so it cannot be granted by inertia.
3. Open a conversation in Chat.
4. Choose Markdown, plain text, JSON, or HTML and select **Download _format_**.

The action reads only Chat's public transcript contract. That contract excludes
provider reasoning, system prompts, hidden extension context, tool-status
records, and retry state. Formatted output is held only in the sandboxed
contribution frame while the download is created. The browser manages the
download; the app cannot choose its destination or read files from the device.

To keep the contribution responsive, one export is limited to 10,000 public
messages, 8 MiB of transcript data, and 32 MiB of formatted output. Chat Export
reports a clear error instead of retaining or downloading content beyond those
limits.

The HTML format escapes all conversation content and includes a deny-by-default
Content Security Policy. Other formats are downloaded as text and are not rendered
inside Kestral.

## App-Owned Data

Chat Export declares `data: { "kind": "none" }` in its package manifest. It has
no app-owned durable data: host-stored config, secrets, Kestral artifacts, and
private surface-state envelopes are separate host-owned concerns and this app
declares none. Export content exists only in the contribution frame's memory
while the file is prepared. The browser-managed download is owned by the user
and browser, not retained by Chat Export or addressable as app data.

## Permission Boundary

The active thread resource ID comes from Chat's versioned `thread-actions` v1
context. An ID identifies the resource to request; it does not confer authority.
The install grant is broad, but every read still requests only the visible
conversation's exact resource ID and follows Kestral's complete grant and
action path under Chat Export's app identity. If you withhold the install grant,
you can grant the same declared permission later under **Settings > Permissions**.

## Host And Runtime

Chat Export is an ordinary external Kestral app. It is not bundled with Kestral
and is compatible with hosts that support package format 1 and
`min_host_version` `0.1.0-alpha.1`.

The package has no native backend and ships no runtime process. Node.js is only
required to build and test the repository; the supported toolchain is Node.js
22.19.x. At runtime, the compiled Svelte surface runs in Kestral's sandboxed
opaque-origin frame. It has no Tauri API, filesystem access, credential access,
or direct network access.

## Build And Test

Run the following from the app repository. Schema validation must use a pinned
public Kestral checkout, not a parent-relative path or a developer's local
source path:

```sh
npm ci
npm run check
npm test
npm run test:package-schema -- /absolute/path/to/pinned-kestral/schemas/app.schema.json
npm run test:package-digest
npm run test:reproducible
```

`npm run build` compiles the Svelte surface, generates notices for every
runtime dependency actually included in the browser bundle, and writes the app
license and those notices as integrity-listed package assets. It does not run a
Kestral host or a Tauri test. The package digest is the canonical Kestral
digest over `app.json` and every declared payload file.

CI checks the package schema from a pinned public Kestral commit, checks the
canonical digest, rebuilds the package reproducibly, and requires the checked-
in `dist/` output to remain unchanged. This repository owns its dependencies,
tests, and package output. It is ignored by the Kestral core checkout.

## Installation And Permissions

1. Run `npm ci && npm run build` in this repository.
2. In Kestral, open **Apps > Install an app > Local folder** and choose `dist/`.
3. Select **Review app** and inspect the identity, checksums, surface, and
   permission request before installation.
4. Select the broad `chat.read_thread` request only when you want Chat Export
   to work across all current and future conversations. Kestral leaves this
   request unchecked by default; nothing is granted by installing the package.

Chat Export requests no capability of its own and declares no app-owned data.
When the grant is denied, the export action remains unavailable and no denied
grant is treated as authority. Each later export still supplies the exact
visible thread resource ID through the normal Kestral action path. The frame
cannot read local files or choose the browser download destination.
