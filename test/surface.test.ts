// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChatExport from "../src/surface/ChatExport.svelte";
import type { ThreadPage } from "../src/shared/types";

const context = {
  thread_id: "thread-1",
  resource_id: "chat-thread-abc",
  revision: 3,
};

const page: ThreadPage = {
  thread: {
    resource_id: context.resource_id,
    thread_id: context.thread_id,
    title: "Plan the launch",
    revision: context.revision,
    created_at: "2026-07-30T10:00:00Z",
    updated_at: "2026-07-30T11:00:00Z",
  },
  messages: [
    {
      message_id: "message-1",
      thread_resource_id: context.resource_id,
      sequence: 0,
      role: "user",
      status: "completed",
      text: "Draft a launch checklist.",
      artifact_refs: [],
      run_ref: null,
      created_at: "2026-07-30T10:00:00Z",
      completed_at: "2026-07-30T10:00:01Z",
    },
  ],
  next_cursor: null,
};

type MountedComponent = Parameters<typeof unmount>[0];
const mounted: MountedComponent[] = [];
const createObjectURL = vi.fn((_blob: Blob) => "blob:kestral-chat-export");
const revokeObjectURL = vi.fn();
let downloads: Array<{ fileName: string; href: string }> = [];

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function renderSurface(invokeScoped = vi.fn().mockResolvedValue({
  result: { kind: "completed", result: page },
})) {
  let init: ((value: { extensionContext: unknown }) => void) | null = null;
  const appHost = {
    onInit(callback: (value: { extensionContext: unknown }) => void) {
      init = callback;
    },
    ready() {
      init?.({ extensionContext: context });
    },
    invokeScoped,
  };
  (globalThis as typeof globalThis & { appHost?: typeof appHost }).appHost = appHost;
  const component = mount(ChatExport, { target: document.body });
  mounted.push(component);
  return {
    invokeScoped,
    initialize(extensionContext: unknown) {
      init?.({ extensionContext });
    },
  };
}

beforeEach(() => {
  downloads = [];
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ fileName: this.download, href: this.href });
  });
});

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!);
  document.body.replaceChildren();
  delete (globalThis as typeof globalThis & { appHost?: unknown }).appHost;
  vi.restoreAllMocks();
});

describe("Chat Export surface", () => {
  it("keeps guidance collapsed until the user asks for it", async () => {
    renderSurface();
    await tick();

    const about = document.querySelector<HTMLDetailsElement>("details.about");
    expect(about?.open).toBe(false);
    expect(about?.querySelector("summary")?.textContent).toBe("What gets exported?");
    expect(about?.textContent).toContain("details such as timestamps");
    expect(about?.textContent).toContain("Hidden prompts and model reasoning are not included");
    expect(about?.querySelector("#format-help")?.textContent).toContain(
      "Best for notes, documents, and sharing.",
    );
    expect(document.querySelector('label[for="export-format"]')?.textContent).toBe("Format");
    expect(document.querySelector("#export-status")).toBeNull();
    expect(buttonNamed("Download Markdown").disabled).toBe(false);
  });

  it("uses the first authoritative page when the visible revision hint is stale", async () => {
    const changedPage = {
      ...page,
      thread: { ...page.thread, revision: page.thread.revision + 1 },
    };
    const invokeScoped = vi.fn().mockResolvedValue({
      result: { kind: "completed", result: changedPage },
    });
    renderSurface(invokeScoped);

    buttonNamed("Download Markdown").click();
    await vi.waitFor(() => {
      expect(document.querySelector("#export-status")?.textContent).toContain("download started");
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(invokeScoped).toHaveBeenCalledWith(
      { provider: "chat", capability: "chat.read_thread" },
      { resource_id: context.resource_id, limit: 100 },
      { kind: "resources", resource_ids: [context.resource_id] },
      "Export the visible Chat conversation",
    );
    expect(downloads).toEqual([{
      fileName: "chat-plan-the-launch.md",
      href: "blob:kestral-chat-export",
    }]);
  });

  it("collects a multi-page transcript with monotonic cursors", async () => {
    const secondMessage = {
      ...page.messages[0],
      message_id: "message-2",
      sequence: 1,
      role: "assistant" as const,
      text: "Run the release checks.",
    };
    const invokeScoped = vi.fn()
      .mockResolvedValueOnce({
        result: { kind: "completed", result: { ...page, next_cursor: 0 } },
      })
      .mockResolvedValueOnce({
        result: { kind: "completed", result: { ...page, messages: [secondMessage] } },
      });
    renderSurface(invokeScoped);

    buttonNamed("Download Markdown").click();

    await vi.waitFor(() => {
      expect(document.querySelector("#export-status")?.textContent).toContain("2 messages");
    });
    expect(document.querySelector("#export-status")?.textContent).toContain("2 messages");
    expect(invokeScoped).toHaveBeenNthCalledWith(
      2,
      { provider: "chat", capability: "chat.read_thread" },
      { resource_id: context.resource_id, limit: 100, cursor: 0 },
      { kind: "resources", resource_ids: [context.resource_id] },
      "Export the visible Chat conversation",
    );
  });

  it("still refuses a real revision change between transcript pages", async () => {
    const secondMessage = {
      ...page.messages[0],
      message_id: "message-2",
      sequence: 1,
      role: "assistant" as const,
      text: "Run the release checks.",
    };
    const invokeScoped = vi.fn()
      .mockResolvedValueOnce({
        result: { kind: "completed", result: { ...page, next_cursor: 0 } },
      })
      .mockResolvedValueOnce({
        result: {
          kind: "completed",
          result: {
            ...page,
            thread: { ...page.thread, revision: page.thread.revision + 1 },
            messages: [secondMessage],
          },
        },
      });
    renderSurface(invokeScoped);

    buttonNamed("Download Markdown").click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "conversation changed while it was being exported",
      );
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects an empty continuation page instead of following its cursor", async () => {
    const invokeScoped = vi.fn()
      .mockResolvedValueOnce({
        result: {
          kind: "completed",
          result: { ...page, messages: [], next_cursor: 1 },
        },
      })
      .mockResolvedValueOnce({ result: { kind: "completed", result: page } });
    renderSurface(invokeScoped);

    buttonNamed("Download Markdown").click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "invalid transcript cursor",
      );
    });
    expect(invokeScoped).toHaveBeenCalledOnce();
  });

  it("rejects duplicate messages across transcript pages", async () => {
    const invokeScoped = vi.fn()
      .mockResolvedValueOnce({
        result: { kind: "completed", result: { ...page, next_cursor: 0 } },
      })
      .mockResolvedValueOnce({
        result: {
          kind: "completed",
          result: { ...page, messages: [{ ...page.messages[0], sequence: 1 }] },
        },
      });
    renderSurface(invokeScoped);

    buttonNamed("Download Markdown").click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "duplicate transcript message",
      );
    });
  });

  it("rejects a transcript that exceeds the aggregate export budget", async () => {
    const messages = Array.from({ length: 9 }, (_, sequence) => ({
      ...page.messages[0],
      message_id: `message-${sequence}`,
      sequence,
      text: "x".repeat(1_000_000),
    }));
    renderSurface(vi.fn().mockResolvedValue({
      result: { kind: "completed", result: { ...page, messages } },
    }));

    buttonNamed("Download Markdown").click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "too large to export",
      );
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("does not mistake a provider failure for a permission refusal", async () => {
    renderSurface(vi.fn().mockResolvedValue({
      result: { kind: "failed", error: "permission: upstream unavailable" },
    }));

    buttonNamed("Download Markdown").click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "permission: upstream unavailable",
      );
    });
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("Permission needed");
  });

  it("explains how to recover from a permission refusal", async () => {
    renderSurface(vi.fn().mockResolvedValue({
      result: { kind: "refused", reason: "no-grant" },
    }));

    buttonNamed("Download Markdown").click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Settings > Permissions",
      );
    });
  });

  it("rejects formatted output that exceeds the download budget", async () => {
    const messages = Array.from({ length: 6 }, (_, sequence) => ({
      ...page.messages[0],
      message_id: `message-${sequence}`,
      sequence,
      text: "\0".repeat(1_000_000),
    }));
    renderSurface(vi.fn().mockResolvedValue({
      result: { kind: "completed", result: { ...page, messages } },
    }));
    const select = document.querySelector<HTMLSelectElement>("#export-format");
    if (!select) throw new Error("Format select not found");
    select.value = "json";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    buttonNamed("Download JSON").click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "formatted export is too large",
      );
    });
  });

  it("downloads the selected format with one action", async () => {
    renderSurface();
    const select = document.querySelector<HTMLSelectElement>("#export-format");
    if (!select) throw new Error("Format select not found");
    select.value = "json";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    buttonNamed("Download JSON").click();

    await vi.waitFor(() => {
      expect(document.querySelector("#export-status")?.textContent).toContain(
        "chat-plan-the-launch.json download started",
      );
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect((createObjectURL.mock.calls[0]?.[0] as Blob).type).toBe("application/json;charset=utf-8");
    expect(downloads).toEqual([{
      fileName: "chat-plan-the-launch.json",
      href: "blob:kestral-chat-export",
    }]);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("silently discards an export response after a same-revision context switch", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    const invokeScoped = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    const surface = renderSurface(invokeScoped);

    buttonNamed("Download Markdown").click();
    await vi.waitFor(() => expect(invokeScoped).toHaveBeenCalledOnce());
    surface.initialize({
      thread_id: "thread-2",
      resource_id: "chat-thread-other",
      revision: context.revision,
    });
    resolveRead({ result: { kind: "completed", result: page } });

    await vi.waitFor(() => {
      expect(buttonNamed("Download Markdown").disabled).toBe(false);
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("export lifecycle regressions", () => {
  it("ignores repeated clicks before Svelte updates disabled controls", async () => {
    const surface = renderSurface(vi.fn().mockReturnValue(new Promise(() => {})));
    const download = buttonNamed("Download Markdown");
    download.click();
    download.click();
    await tick();
    expect(surface.invokeScoped).toHaveBeenCalledOnce();
  });

  it("does not continue pagination or download after the component is destroyed", async () => {
    let finishRead!: (value: unknown) => void;
    const surface = renderSurface(vi.fn().mockReturnValue(new Promise((resolve) => { finishRead = resolve; })));
    buttonNamed("Download Markdown").click();
    await tick();
    await unmount(mounted.pop()!);
    finishRead({ result: { kind: "completed", result: { ...page, next_cursor: 0 } } });
    await tick();
    expect(surface.invokeScoped).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("cleans up the link and transcript URL if the browser rejects the download", async () => {
    renderSurface();
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new Error("Download unavailable");
    });
    buttonNamed("Download Markdown").click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Download unavailable");
    });
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:kestral-chat-export");
    expect(document.querySelector("#export-status")).toBeNull();
  });

  it.each(["cancelled", "approval-denied"])("does not suggest broader permissions for %s", async (reason) => {
    renderSurface(vi.fn().mockResolvedValue({ result: { kind: "refused", reason } }));
    buttonNamed("Download Markdown").click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    const text = document.querySelector('[role="alert"]')?.textContent;
    expect(text).not.toContain("grant Chat Export access to all Chat conversations");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});


describe("export resource limits and cleanup", () => {
  it("enforces the transcript byte limit even when the conversation has no messages", async () => {
    renderSurface(vi.fn().mockResolvedValue({
      result: { kind: "completed", result: {
        ...page, messages: [], thread: { ...page.thread, updated_at: "x".repeat(8 * 1024 * 1024) },
      } },
    }));
    buttonNamed("Download Markdown").click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("8 MiB transcript limit"));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes rather than character counts against the transcript budget", async () => {
    const messages = Array.from({ length: 3 }, (_, sequence) => ({
      ...page.messages[0], message_id: `unicode-${sequence}`, sequence, text: "🪶".repeat(750_000),
    }));
    renderSurface(vi.fn().mockResolvedValue({ result: { kind: "completed", result: { ...page, messages } } }));
    buttonNamed("Download Markdown").click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("8 MiB transcript limit"));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([10_000, 10_001])("bounds a %i-message paginated transcript", async (total) => {
    const invokeScoped = vi.fn().mockImplementation((_capability, input) => {
      const start = input.cursor === undefined ? 0 : input.cursor + 1;
      const end = Math.min(start + input.limit, total);
      const messages = Array.from({ length: end - start }, (_, index) => ({
        ...page.messages[0], message_id: `message-${start + index}`, sequence: start + index,
      }));
      return Promise.resolve({ result: { kind: "completed", result: {
        ...page, messages, next_cursor: end < total ? end - 1 : null,
      } } });
    });
    renderSurface(invokeScoped);
    buttonNamed("Download Markdown").click();
    if (total === 10_000) {
      await vi.waitFor(() => expect(document.querySelector("#export-status")?.textContent).toContain("10000 messages"));
      expect(createObjectURL).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("10000-message export limit"));
      expect(createObjectURL).not.toHaveBeenCalled();
    }
    expect(invokeScoped).toHaveBeenCalledTimes(Math.ceil(total / 100));
  });

  it("revokes a successful download URL on teardown without a second timer revocation", async () => {
    vi.useFakeTimers();
    try {
      renderSurface();
      buttonNamed("Download Markdown").click();
      await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
      expect(revokeObjectURL).not.toHaveBeenCalled();
      await unmount(mounted.pop()!);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:kestral-chat-export");
      await vi.runAllTimersAsync();
      expect(revokeObjectURL).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes a successful download URL after the browser has had time to consume it", async () => {
    vi.useFakeTimers();
    try {
      renderSurface();
      buttonNamed("Download Markdown").click();
      await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
      expect(revokeObjectURL).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:kestral-chat-export");
      await unmount(mounted.pop()!);
      expect(revokeObjectURL).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
