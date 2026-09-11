<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    formatExport,
    invocationResult,
    InvocationRefusedError,
    parseThreadActionContext,
    parseThreadPage,
  } from "../shared/format";
  import type {
    ChatMessageView,
    ChatThreadRef,
    ChatTranscript,
    ExportFormat,
    ThreadActionContext,
  } from "../shared/types";

  type DataScope = { kind: "resources"; resource_ids: string[] };
  type CapabilityRef = { provider: string; capability: string };
  interface HostInit { extensionContext: unknown }
  interface AppHost {
    ready(): void;
    onInit(callback: (context: HostInit) => void): void;
    invokeScoped(
      capability: CapabilityRef,
      input: Record<string, unknown>,
      dataScope: DataScope,
      goal: string,
    ): Promise<unknown>;
  }

  const surfaceHost = (globalThis as typeof globalThis & { appHost?: AppHost }).appHost;
  if (!surfaceHost) throw new Error("Kestral surface bridge is unavailable");
  const host: AppHost = surfaceHost;

  const MAX_MESSAGES = 10_000;
  const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
  const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
  const utf8Encoder = new TextEncoder();
  const FORMAT_LABELS: Record<ExportFormat, string> = {
    markdown: "Markdown",
    json: "JSON",
    plain: "Plain text",
    html: "HTML",
  };
  const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
    { value: "markdown", label: "Markdown (recommended)" },
    { value: "plain", label: "Plain text" },
    { value: "json", label: "JSON (for other tools)" },
    { value: "html", label: "HTML (web page)" },
  ];
  const FORMAT_HELP: Record<ExportFormat, string> = {
    markdown: "Best for notes, documents, and sharing.",
    plain: "Simple readable text without markup.",
    json: "Keeps transcript fields for use in other tools.",
    html: "Creates a self-contained web page with safely escaped content.",
  };
  const FORMAT_FILES: Record<ExportFormat, { extension: string; mediaType: string }> = {
    markdown: { extension: "md", mediaType: "text/markdown;charset=utf-8" },
    plain: { extension: "txt", mediaType: "text/plain;charset=utf-8" },
    json: { extension: "json", mediaType: "application/json;charset=utf-8" },
    html: { extension: "html", mediaType: "text/html;charset=utf-8" },
  };

  let context = $state<ThreadActionContext | null>(null);
  let format = $state<ExportFormat>("markdown");
  let busy = $state(false);
  let status = $state<string | null>(null);
  let error = $state<string | null>(null);
  let operationGeneration = 0;
  let destroyed = false;
  const downloadUrls = new Map<string, ReturnType<typeof setTimeout>>();

  onDestroy(() => {
    destroyed = true;
    operationGeneration += 1;
    for (const [url, timer] of downloadUrls) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    downloadUrls.clear();
  });

  host.onInit((init) => {
    if (destroyed) return;
    try {
      context = parseThreadActionContext(init.extensionContext);
      resetExportState();
    } catch {
      context = null;
      resetExportState();
      error = "Chat Export couldn't identify this conversation. Switch to another conversation and back, then try again.";
    }
  });
  host.ready();

  function resetExportState(): void {
    operationGeneration += 1;
    busy = false;
    error = null;
    status = null;
  }

  function utf8Length(values: Array<string | null>): number {
    return values.reduce(
      (length, value) => length + (value === null ? 0 : utf8Encoder.encode(value).byteLength),
      0,
    );
  }

  function threadSize(thread: ChatThreadRef): number {
    return utf8Length([
      thread.resource_id,
      thread.thread_id,
      thread.title,
      thread.created_at,
      thread.updated_at,
    ]);
  }

  function messageSize(message: ChatMessageView): number {
    return utf8Length([
      message.message_id,
      message.thread_resource_id,
      message.role,
      message.status,
      message.text,
      ...message.artifact_refs,
      message.run_ref,
      message.created_at,
      message.completed_at,
    ]);
  }

  function sameThread(left: ChatThreadRef, right: ChatThreadRef): boolean {
    return left.resource_id === right.resource_id
      && left.thread_id === right.thread_id
      && left.title === right.title
      && left.revision === right.revision
      && left.created_at === right.created_at
      && left.updated_at === right.updated_at;
  }

  async function readConversation(
    active: ThreadActionContext,
    isCurrent: () => boolean,
  ): Promise<ChatTranscript | null> {
    const messages: ChatMessageView[] = [];
    let thread: ChatThreadRef | null = null;
    let cursor: number | undefined;
    let lastSequence: number | undefined;
    let transcriptBytes = 0;
    const messageIds = new Set<string>();
    for (;;) {
      const input: Record<string, unknown> = { resource_id: active.resource_id, limit: 100 };
      if (cursor !== undefined) input.cursor = cursor;
      const outcome = await host.invokeScoped(
        { provider: "chat", capability: "chat.read_thread" },
        input,
        { kind: "resources", resource_ids: [active.resource_id] },
        "Export the visible Chat conversation",
      );
      if (!isCurrent()) return null;
      const page = parseThreadPage(invocationResult(outcome));
      if (page.thread.resource_id !== active.resource_id || page.thread.thread_id !== active.thread_id) {
        throw new Error("Chat returned a different conversation");
      }
      if (thread && !sameThread(page.thread, thread)) {
        throw new Error("The conversation changed while it was being exported. Try again.");
      }
      if (!thread) {
        thread = page.thread;
        transcriptBytes = threadSize(thread);
        if (transcriptBytes > MAX_TRANSCRIPT_BYTES) {
          throw new Error("This conversation is too large to export (8 MiB transcript limit).");
        }
      }
      if (messages.length + page.messages.length > MAX_MESSAGES) {
        throw new Error(`This conversation exceeds the ${MAX_MESSAGES}-message export limit`);
      }
      for (const message of page.messages) {
        if (messageIds.has(message.message_id)) {
          throw new Error("Chat returned a duplicate transcript message");
        }
        if (lastSequence !== undefined && message.sequence <= lastSequence) {
          throw new Error("Chat returned messages in an invalid order");
        }
        messageIds.add(message.message_id);
        lastSequence = message.sequence;
        transcriptBytes += messageSize(message);
        if (transcriptBytes > MAX_TRANSCRIPT_BYTES) {
          throw new Error("This conversation is too large to export (8 MiB transcript limit).");
        }
      }
      messages.push(...page.messages);
      if (page.next_cursor === null) break;
      const pageLastSequence = page.messages.at(-1)?.sequence;
      if (
        pageLastSequence === undefined
        || page.next_cursor !== pageLastSequence
        || (cursor !== undefined && page.next_cursor <= cursor)
      ) {
        throw new Error("Chat returned an invalid transcript cursor");
      }
      cursor = page.next_cursor;
    }
    if (!thread) throw new Error("Chat returned no conversation");
    return { thread, messages };
  }

  function friendlyError(failure: unknown): string {
    if (failure instanceof InvocationRefusedError) {
      if (failure.reason === "cancelled") {
        return "The export was cancelled or timed out. No file was downloaded. Try again when you're ready.";
      }
      if (failure.reason === "approval-denied") {
        return "Export approval was declined. No file was downloaded. You can try again and approve the read.";
      }
      return "Permission needed. In Settings > Permissions, review Chat Export's chat.read_thread permission for this conversation, then try again.";
    }
    return failure instanceof Error ? failure.message : String(failure);
  }

  function exportFileName(title: string, activeFormat: ExportFormat): string {
    const stem = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "conversation";
    return `chat-${stem}.${FORMAT_FILES[activeFormat].extension}`;
  }

  function downloadOutput(output: string, fileName: string, mediaType: string): void {
    const blob = new Blob([output], { type: mediaType });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    try {
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
    } catch (failure) {
      URL.revokeObjectURL(url);
      throw failure;
    } finally {
      link.remove();
    }
    // Give the browser time to consume the URL, but don't retain transcript
    // blobs if the surface is destroyed before this timer fires.
    downloadUrls.set(url, setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadUrls.delete(url);
    }, 1_000));
  }

  async function download(): Promise<void> {
    if (busy || destroyed) return;
    if (!context) {
      error = "The visible conversation is unavailable.";
      return;
    }
    const active = context;
    const activeFormat = format;
    const generation = ++operationGeneration;
    busy = true;
    error = null;
    status = null;
    try {
      const page = await readConversation(active, () => generation === operationGeneration);
      if (!page || generation !== operationGeneration) return;
      const output = formatExport(page, activeFormat);
      if (utf8Encoder.encode(output).byteLength > MAX_EXPORT_BYTES) {
        throw new Error("The formatted export is too large to download (32 MiB output limit).");
      }
      const file = FORMAT_FILES[activeFormat];
      const fileName = exportFileName(page.thread.title, activeFormat);
      downloadOutput(output, fileName, file.mediaType);
      const messageCount = page.messages.length;
      status = `${fileName} download started - ${messageCount} message${messageCount === 1 ? "" : "s"}`;
    } catch (failure) {
      if (generation !== operationGeneration) return;
      error = friendlyError(failure);
      status = null;
    } finally {
      if (generation === operationGeneration) busy = false;
    }
  }
</script>

<div class="export-surface" aria-busy={busy}>
  <div class="export-control">
    <label for="export-format">Format</label>
    <select
      id="export-format"
      bind:value={format}
      disabled={busy}
      onchange={resetExportState}
    >
      {#each FORMAT_OPTIONS as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
    <button type="button" onclick={download} disabled={busy || !context}>
      {busy ? "Preparing..." : `Download ${FORMAT_LABELS[format]}`}
    </button>
    <details class="about">
      <summary>What gets exported?</summary>
      <div class="about-content">
        <p>
          Messages and details such as timestamps from this conversation. Hidden prompts and model reasoning are not included.
        </p>
        <p id="format-help"><strong>{FORMAT_LABELS[format]}:</strong> {FORMAT_HELP[format]}</p>
      </div>
    </details>
  </div>

  {#if status}
    <p id="export-status" class="status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</div>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html), :global(body) {
    margin: 0;
    min-width: 0;
    color: var(--color-text);
    background: transparent;
    font: 400 0.8125rem/1.45 system-ui, "Segoe UI", sans-serif;
  }
  :global(button), :global(select) { font: inherit; }
  .export-surface {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
  }
  .about-content p, .status, .error {
    margin: 0;
    max-width: 65ch;
    overflow-wrap: anywhere;
  }
  .export-control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }
  .export-control > label {
    color: var(--color-text-muted);
    font-weight: 650;
  }
  .about {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--color-text-muted);
  }
  .about[open] {
    flex-basis: 100%;
  }
  .about summary {
    width: fit-content;
    min-height: 2.25rem;
    display: list-item;
    padding-block: 0.4rem;
    cursor: pointer;
    font-weight: 600;
  }
  .about summary:focus-visible {
    outline: 0.2rem solid var(--color-focus-ring);
    outline-offset: 0.12rem;
    border-radius: 0.25rem;
  }
  .about-content {
    display: grid;
    gap: 0.25rem;
    padding: 0.2rem 0 0.25rem;
  }
  select, button {
    border: 1px solid var(--color-border);
    border-radius: 0.55rem;
    color: var(--color-text);
    background: var(--color-surface-raised);
    min-height: 2.25rem;
    padding: 0.3em 0.65em;
  }
  select {
    flex: 0 1 14rem;
    min-width: min(100%, 10rem);
  }
  button {
    cursor: pointer;
    border-color: var(--color-accent);
    color: var(--color-accent-contrast);
    background: var(--color-accent);
    font-weight: 700;
    white-space: nowrap;
  }
  button:disabled, select:disabled { cursor: not-allowed; opacity: 0.6; }
  button:focus-visible, select:focus-visible {
    outline: 0.2rem solid var(--color-focus-ring);
    outline-offset: 0.12rem;
  }
  .status { color: var(--color-text-muted); }
  .error {
    color: var(--color-danger-text);
  }
  @media (max-width: 24em) {
    .export-control > label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    select, button { flex: 1 1 8rem; }
    .about { flex-basis: 100%; }
  }
</style>
