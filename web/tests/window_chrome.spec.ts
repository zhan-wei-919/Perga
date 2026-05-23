import { describe, expect, it } from "vitest";

import { shouldShowWindowChrome } from "../src/ui/window_chrome";

describe("shouldShowWindowChrome", () => {
  it("shows only in desktop Tauri", () => {
    expect(shouldShowWindowChrome({ kind: "desktop", isTauri: true })).toBe(
      true,
    );
    expect(shouldShowWindowChrome({ kind: "desktop", isTauri: false })).toBe(
      false,
    );
    expect(shouldShowWindowChrome({ kind: "mobile", isTauri: true })).toBe(
      false,
    );
    expect(shouldShowWindowChrome(undefined)).toBe(false);
  });
});
