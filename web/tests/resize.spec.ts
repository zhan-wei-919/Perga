import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeContainerResize } from "../src/input/resize";
import type { CellMetrics } from "../src/render/metrics";

const METRICS: CellMetrics = {
  cellW: 10,
  cellH: 5,
  baseline: 4,
  fontFamily: "monospace",
  fontSize: 10,
};

const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

class FakeResizeObserver implements ResizeObserver {
  static last: FakeResizeObserver | null = null;

  readonly callback: ResizeObserverCallback;
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.last = this;
  }

  emit(): void {
    this.callback([], this);
  }
}

let rafCallback: FrameRequestCallback | null = null;
let rafId = 0;

beforeEach(() => {
  FakeResizeObserver.last = null;
  rafCallback = null;
  rafId = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: FakeResizeObserver,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((cb: FrameRequestCallback) => {
      rafCallback = cb;
      rafId += 1;
      return rafId;
    }),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn(() => {
      rafCallback = null;
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: originalResizeObserver,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: originalRequestAnimationFrame,
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: originalCancelAnimationFrame,
  });
});

describe("observeContainerResize", () => {
  it("coalesces ResizeObserver bursts into one animation frame", () => {
    const box = mutableBox(100, 50);
    const seen: Array<[number, number]> = [];
    observeContainerResize(box.el, METRICS, (rows, cols) => {
      seen.push([rows, cols]);
    });

    box.set(124, 78);
    FakeResizeObserver.last?.emit();
    FakeResizeObserver.last?.emit();

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);

    runRaf();

    expect(seen).toEqual([[15, 12]]);
  });

  it("skips the initial observer notification and same-cell resizes", () => {
    const box = mutableBox(100, 50);
    const seen: Array<[number, number]> = [];
    observeContainerResize(box.el, METRICS, (rows, cols) => {
      seen.push([rows, cols]);
    });

    FakeResizeObserver.last?.emit();
    runRaf();
    box.set(109, 54);
    FakeResizeObserver.last?.emit();
    runRaf();
    box.set(110, 55);
    FakeResizeObserver.last?.emit();
    runRaf();

    expect(seen).toEqual([[11, 11]]);
  });

  it("cancels a pending frame on dispose", () => {
    const box = mutableBox(100, 50);
    const handle = observeContainerResize(box.el, METRICS, () => {});

    box.set(200, 80);
    FakeResizeObserver.last?.emit();
    handle.dispose();

    expect(FakeResizeObserver.last?.disconnect).toHaveBeenCalledTimes(1);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(rafCallback).toBeNull();
  });
});

function mutableBox(width: number, height: number): {
  el: HTMLElement;
  set: (nextWidth: number, nextHeight: number) => void;
} {
  const el = document.createElement("div");
  let current = { width, height };
  vi.spyOn(el, "getBoundingClientRect").mockImplementation(() =>
    domRect(current.width, current.height),
  );
  return {
    el,
    set: (nextWidth, nextHeight) => {
      current = { width: nextWidth, height: nextHeight };
    },
  };
}

function domRect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function runRaf(): void {
  const cb = rafCallback;
  rafCallback = null;
  cb?.(performance.now());
}
