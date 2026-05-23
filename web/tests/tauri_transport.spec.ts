import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolEvent } from "../src/state/protocol";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  handlers: new Map<string, (event: { payload: ProtocolEvent }) => void>(),
  sessionOpenArgs: null as Record<string, unknown> | null,
}));

const INIT_EVENT: ProtocolEvent = {
  type: "init",
  seq: 1,
  size: { rows: 2, cols: 3 },
  cursor: { row: 0, col: 0, visible: true, style: "block" },
  rows: [[{ type: "blank", count: 3 }], [{ type: "blank", count: 3 }]],
  modes: {
    alt_screen: false,
    app_cursor: false,
    bracketed_paste: false,
    mouse_reporting: "off",
    sgr_mouse: false,
    focus_reporting: false,
  },
  title: null,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== "session_open") return undefined;
    mocks.calls.push("invoke:session_open");
    mocks.sessionOpenArgs = args ?? {};
    const sessionId = args?.sessionId;
    if (typeof sessionId === "string") {
      mocks.handlers.get(`session_event:${sessionId}`)?.({ payload: INIT_EVENT });
    }
    return undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    eventName: string,
    cb: (event: { payload: ProtocolEvent }) => void,
  ) => {
    mocks.calls.push(`listen:${eventName}`);
    mocks.handlers.set(eventName, cb);
    return () => {
      mocks.calls.push(`unlisten:${eventName}`);
      mocks.handlers.delete(eventName);
    };
  },
}));

import { createTauriTransport } from "../src/net/tauri";

describe("createTauriTransport", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.handlers.clear();
    mocks.sessionOpenArgs = null;
  });

  it("subscribes before session_open so the initial Init event cannot be missed", async () => {
    const onEvent = vi.fn();

    createTauriTransport({
      rows: 2,
      cols: 3,
      profileId: undefined,
      onEvent,
      onClose: vi.fn(),
    });

    await eventually(() => expect(mocks.sessionOpenArgs).not.toBeNull());

    const sessionId = mocks.sessionOpenArgs?.sessionId;
    expect(typeof sessionId).toBe("string");
    expect(mocks.calls).toEqual([
      `listen:session_event:${sessionId}`,
      "invoke:session_open",
    ]);
    expect(onEvent).toHaveBeenCalledWith(INIT_EVENT);
  });
});

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (e) {
      last = e;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw last;
}
