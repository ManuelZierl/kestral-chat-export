import type {
  ChatMessageView,
  ChatTranscript,
  ChatThreadRef,
  ExportFormat,
  MessageRole,
  MessageStatus,
  ThreadActionContext,
  ThreadPage,
} from "./types";

const ROLES = new Set<MessageRole>(["user", "assistant"]);
const STATUSES = new Set<MessageStatus>([
  "pending",
  "completed",
  "interrupted",
  "cancelled",
  "failed",
]);
const REFUSAL_REASONS = new Set([
  "no-grant",
  "grant-expired",
  "grant-revoked",
  "approval-denied",
  "cancelled",
]);
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_THREAD_TITLE_LENGTH = 200;
const MAX_MESSAGE_TEXT_LENGTH = 1_048_576;

export class InvocationRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`permission:${reason}`);
    this.name = "InvocationRefusedError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(
  value: unknown,
  path: string,
  allowEmpty = false,
  maxLength?: number,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new Error(`${path} must be at most ${maxLength} characters`);
  }
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function nullableString(value: unknown, path: string, maxLength?: number): string | null {
  if (value === null) return null;
  return stringValue(value, path, false, maxLength);
}

function stringArray(value: unknown, path: string, maxItems: number, maxLength?: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${path} must be an array with at most ${maxItems} entries`);
  }
  return value.map((item, index) => stringValue(item, `${path}[${index}]`, false, maxLength));
}

function parseThread(value: unknown): ChatThreadRef {
  if (!isObject(value)) throw new Error("thread must be an object");
  return {
    resource_id: stringValue(value.resource_id, "thread.resource_id", false, MAX_IDENTIFIER_LENGTH),
    thread_id: stringValue(value.thread_id, "thread.thread_id", false, MAX_IDENTIFIER_LENGTH),
    title: stringValue(value.title, "thread.title", false, MAX_THREAD_TITLE_LENGTH),
    revision: integerValue(value.revision, "thread.revision"),
    created_at: stringValue(value.created_at, "thread.created_at"),
    updated_at: stringValue(value.updated_at, "thread.updated_at"),
  };
}

function parseMessage(value: unknown, index: number, resourceId: string): ChatMessageView {
  const path = `messages[${index}]`;
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  const role = stringValue(value.role, `${path}.role`) as MessageRole;
  if (!ROLES.has(role)) throw new Error(`${path}.role is unsupported`);
  const status = stringValue(value.status, `${path}.status`) as MessageStatus;
  if (!STATUSES.has(status)) throw new Error(`${path}.status is unsupported`);
  const threadResourceId = stringValue(
    value.thread_resource_id,
    `${path}.thread_resource_id`,
    false,
    MAX_IDENTIFIER_LENGTH,
  );
  if (threadResourceId !== resourceId) throw new Error(`${path} belongs to a different conversation`);
  return {
    message_id: stringValue(value.message_id, `${path}.message_id`, false, MAX_IDENTIFIER_LENGTH),
    thread_resource_id: threadResourceId,
    sequence: integerValue(value.sequence, `${path}.sequence`),
    role,
    status,
    text: stringValue(value.text, `${path}.text`, true, MAX_MESSAGE_TEXT_LENGTH),
    artifact_refs: stringArray(
      value.artifact_refs,
      `${path}.artifact_refs`,
      100,
      MAX_IDENTIFIER_LENGTH,
    ),
    run_ref: nullableString(value.run_ref, `${path}.run_ref`),
    created_at: stringValue(value.created_at, `${path}.created_at`),
    completed_at: nullableString(value.completed_at, `${path}.completed_at`),
  };
}

export function parseThreadPage(value: unknown): ThreadPage {
  if (!isObject(value)) throw new Error("Chat returned an invalid transcript page");
  const thread = parseThread(value.thread);
  if (!Array.isArray(value.messages) || value.messages.length > 100) {
    throw new Error("messages must be an array with at most 100 entries");
  }
  if (!Object.hasOwn(value, "next_cursor")) {
    throw new Error("next_cursor is required");
  }
  const nextCursor = value.next_cursor;
  if (nextCursor !== null) {
    integerValue(nextCursor, "next_cursor");
  }
  return {
    thread,
    messages: value.messages.map((message, index) => parseMessage(message, index, thread.resource_id)),
    next_cursor: nextCursor as number | null,
  };
}

export function parseThreadActionContext(value: unknown): ThreadActionContext {
  if (!isObject(value)) throw new Error("Chat did not provide conversation context");
  return {
    thread_id: stringValue(value.thread_id, "thread_id", false, MAX_IDENTIFIER_LENGTH),
    resource_id: stringValue(value.resource_id, "resource_id", false, MAX_IDENTIFIER_LENGTH),
    revision: integerValue(value.revision, "revision"),
  };
}

export function invocationResult(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.result)) {
    throw new Error("Kestral returned an invalid action result");
  }
  const result = value.result;
  if (result.kind === "completed") {
    if (!Object.hasOwn(result, "result")) throw new Error("Kestral returned an invalid action result");
    return result.result;
  }
  if (result.kind === "refused") {
    if (typeof result.reason !== "string" || !REFUSAL_REASONS.has(result.reason)) {
      throw new Error("Kestral returned an invalid action result");
    }
    throw new InvocationRefusedError(result.reason);
  }
  if (result.kind === "failed") {
    if (typeof result.error !== "string" || result.error.length === 0) {
      throw new Error("Kestral returned an invalid action result");
    }
    throw new Error(result.error);
  }
  throw new Error("Kestral returned an unsupported action result");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function label(message: ChatMessageView): string {
  return message.role === "user" ? "You" : "Assistant";
}

function metadata(message: ChatMessageView): string[] {
  const values = [`Created: ${message.created_at}`];
  if (message.completed_at) values.push(`Completed: ${message.completed_at}`);
  if (message.status !== "completed") values.push(`Status: ${message.status}`);
  if (message.artifact_refs.length > 0) values.push(`Artifacts: ${message.artifact_refs.join(", ")}`);
  if (message.run_ref) values.push(`Run: ${message.run_ref}`);
  return values;
}

function orderedMessages(page: ChatTranscript): ChatMessageView[] {
  return [...page.messages].sort((left, right) => left.sequence - right.sequence);
}

function formatMarkdown(page: ChatTranscript, exportedAt: string): string {
  const output = [
    `# ${page.thread.title}`,
    "",
    `Exported: ${exportedAt}`,
    `Updated: ${page.thread.updated_at}`,
    "",
  ];
  for (const message of orderedMessages(page)) {
    output.push(`## ${label(message)}`, "", ...metadata(message).map((value) => `_${value}_`), "");
    output.push(message.text || "_(empty message)_", "");
  }
  return `${output.join("\n").trimEnd()}\n`;
}

function formatPlain(page: ChatTranscript, exportedAt: string): string {
  const output = [page.thread.title, `Exported: ${exportedAt}`, `Updated: ${page.thread.updated_at}`, ""];
  for (const message of orderedMessages(page)) {
    output.push(`${label(message)}:`, ...metadata(message).map((value) => `  ${value}`));
    output.push(message.text || "(empty message)", "");
  }
  return `${output.join("\n").trimEnd()}\n`;
}

function formatJson(page: ChatTranscript, exportedAt: string): string {
  return `${JSON.stringify({ exported_at: exportedAt, thread: page.thread, messages: orderedMessages(page) }, null, 2)}\n`;
}

function formatHtml(page: ChatTranscript, exportedAt: string): string {
  const messages = orderedMessages(page).map((message) => {
    const details = metadata(message).map((value) => `<li>${escapeHtml(value)}</li>`).join("");
    return `<article data-role="${message.role}">
<h2>${label(message)}</h2>
<ul>${details}</ul>
<pre>${escapeHtml(message.text)}</pre>
</article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<title>${escapeHtml(page.thread.title)}</title>
</head>
<body>
<main>
<h1>${escapeHtml(page.thread.title)}</h1>
<p>Exported: ${escapeHtml(exportedAt)}<br>Updated: ${escapeHtml(page.thread.updated_at)}</p>
${messages}
</main>
</body>
</html>
`;
}

export function formatExport(
  page: ChatTranscript,
  format: ExportFormat,
  exportedAt = new Date(),
): string {
  const timestamp = exportedAt.toISOString();
  switch (format) {
    case "markdown": return formatMarkdown(page, timestamp);
    case "plain": return formatPlain(page, timestamp);
    case "json": return formatJson(page, timestamp);
    case "html": return formatHtml(page, timestamp);
  }
}
