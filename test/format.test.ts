import { describe, expect, it } from "vitest";
import {
  formatExport,
  invocationResult,
  InvocationRefusedError,
  parseThreadActionContext,
  parseThreadPage,
} from "../src/shared/format";
import type { ThreadPage } from "../src/shared/types";

const sample: ThreadPage = {
  thread: {
    resource_id: "chat-thread-abc",
    thread_id: "thread-1",
    title: "Plan the launch",
    revision: 3,
    created_at: "2026-07-30T10:00:00Z",
    updated_at: "2026-07-30T11:00:00Z",
  },
  messages: [
    {
      message_id: "m1",
      thread_resource_id: "chat-thread-abc",
      sequence: 0,
      role: "user",
      status: "completed",
      text: "Draft a launch checklist.",
      artifact_refs: [],
      run_ref: null,
      created_at: "2026-07-30T10:00:00Z",
      completed_at: "2026-07-30T10:00:01Z",
    },
    {
      message_id: "m2",
      thread_resource_id: "chat-thread-abc",
      sequence: 1,
      role: "assistant",
      status: "completed",
      text: "1. Freeze scope\n2. Run checks",
      artifact_refs: ["artifact-9"],
      run_ref: "run-2",
      created_at: "2026-07-30T10:01:00Z",
      completed_at: "2026-07-30T10:01:30Z",
    },
  ],
  next_cursor: null,
};

describe("thread boundaries", () => {
  it("accepts the exact thread-actions context", () => {
    expect(parseThreadActionContext({
      thread_id: "thread-1",
      resource_id: "chat-thread-abc",
      revision: 3,
    })).toEqual({ thread_id: "thread-1", resource_id: "chat-thread-abc", revision: 3 });
    expect(() => parseThreadActionContext({ thread_id: "thread-1" })).toThrow(/resource_id/);
  });

  it("rejects malformed pages and cross-thread messages", () => {
    expect(parseThreadPage(sample)).toEqual(sample);
    expect(() => parseThreadPage({
      ...sample,
      messages: [{ ...sample.messages[0], thread_resource_id: "chat-thread-other" }],
    })).toThrow(/different conversation/);
    expect(() => parseThreadPage({ ...sample, next_cursor: -1 })).toThrow(/next_cursor/);
    const { next_cursor: _nextCursor, ...missingCursor } = sample;
    expect(() => parseThreadPage(missingCursor)).toThrow(/next_cursor/);
    expect(() => parseThreadPage({
      ...sample,
      messages: [{ ...sample.messages[0], text: "x".repeat(1_048_577) }],
    })).toThrow(/messages\[0\]\.text/);
  });

  it("preserves invocation refusal and failure meaning", () => {
    expect(invocationResult({ result: { kind: "completed", result: sample } })).toEqual(sample);
    expect(() => invocationResult({ result: { kind: "refused", reason: "no-grant" } }))
      .toThrow(InvocationRefusedError);
    expect(() => invocationResult({ result: { kind: "failed", error: "backend failed" } })).toThrow(
      "backend failed",
    );
    expect(() => invocationResult({ result: { kind: "completed" } })).toThrow(/invalid action result/);
    expect(() => invocationResult({ result: { kind: "refused" } })).toThrow(/invalid action result/);
    expect(() => invocationResult({ result: { kind: "failed", error: "" } })).toThrow(
      /invalid action result/,
    );
  });
});

describe("formatExport", () => {
  const exportedAt = new Date("2026-07-30T12:00:00Z");

  it("renders readable Markdown with public metadata", () => {
    const body = formatExport(sample, "markdown", exportedAt);
    expect(body).toContain("# Plan the launch");
    expect(body).toContain("## You");
    expect(body).toContain("Draft a launch checklist.");
    expect(body).toContain("Artifacts: artifact-9");
    expect(body).toContain("Run: run-2");
  });

  it("keeps the complete public transcript in JSON", () => {
    const body = JSON.parse(formatExport(sample, "json", exportedAt));
    expect(body.exported_at).toBe("2026-07-30T12:00:00.000Z");
    expect(body.thread.resource_id).toBe("chat-thread-abc");
    expect(body.messages).toHaveLength(2);
  });

  it("escapes active HTML and ships a deny-by-default policy", () => {
    const page: ThreadPage = {
      ...sample,
      thread: { ...sample.thread, title: `<img src=x onerror="alert(1)">` },
      messages: [{ ...sample.messages[0], text: `<script>alert("x")</script>` }],
    };
    const body = formatExport(page, "html", exportedAt);
    expect(body).toContain("default-src 'none'");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
  });
});
