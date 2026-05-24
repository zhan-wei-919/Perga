// PaneLeaf IME integration regression tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { PaneLeaf } from "../src/ui/pane_leaf";
import { SettingsContext } from "../src/state/settings_context";
import { createSessionStore } from "../src/state/session_store";
import type { SettingsStore } from "../src/state/settings";
import type { LeafSession } from "../src/state/workspace";
import type { ClientMessage } from "../src/state/wire";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const settings: SettingsStore = {
  state: {
    zoomPercent: 100,
    themeId: "dark",
    fontId: "default",
  },
  effectiveFontSize: () => 16,
  fontFamily: () => "monospace",
  setZoom: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  zoomReset: vi.fn(),
  setTheme: vi.fn(),
  setFont: vi.fn(),
};

function makeSession() {
  const sent: ClientMessage[] = [];
  const session: LeafSession = {
    id: "leaf-test",
    store: createSessionStore({ rows: 24, cols: 80 }),
    profileId: undefined,
    connect: vi.fn(),
    send: vi.fn((msg: ClientMessage) => sent.push(msg)),
    dispose: vi.fn(),
    reportRenderScheduled: vi.fn(),
    reportRenderFrame: vi.fn(),
    reportRenderCancelled: vi.fn(),
  };
  return { session, sent };
}

describe("PaneLeaf IME input", () => {
  let restoreRect: (() => void) | undefined;
  let restoreRaf: (() => void) | undefined;
  let restoreResizeObserver: (() => void) | undefined;

  beforeEach(() => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.tagName === "SPAN") {
        const len = this.textContent?.length ?? 0;
        return rect(len * 8, 21);
      }
      return rect(800, 500);
    };
    restoreRect = () => {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    };

    const originalRaf = window.requestAnimationFrame;
    const originalCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(performance.now());
      return 1;
    };
    window.cancelAnimationFrame = () => undefined;
    restoreRaf = () => {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    };

    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
    restoreResizeObserver = () => {
      globalThis.ResizeObserver = originalResizeObserver;
    };
  });

  afterEach(() => {
    restoreRect?.();
    restoreRaf?.();
    restoreResizeObserver?.();
  });

  it("commits IME text from InputEvent.data when textarea value is not updated", () => {
    const { session, sent } = makeSession();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = render(
      () => (
        <SettingsContext.Provider value={settings}>
          <PaneLeaf
            session={session}
            focused={true}
            onFocusRequest={vi.fn()}
          />
        </SettingsContext.Provider>
      ),
      root,
    );

    const input = root.querySelector("textarea");
    if (!input) throw new Error("missing IME input proxy");
    sent.length = 0;
    vi.mocked(session.send).mockClear();

    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "" }),
    );
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "你",
        inputType: "insertFromComposition",
      }),
    );

    expect(sent).toContainEqual({ type: "paste", text: "你" });

    dispose();
    root.remove();
  });
});

function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  };
}
