import { describe, expect, it } from "vitest";

import { shouldShowWindowControls } from "../src/ui/top_bar";

describe("shouldShowWindowControls", () => {
  it("shows only in desktop Tauri", () => {
    expect(shouldShowWindowControls({ kind: "desktop", isTauri: true })).toBe(
      true,
    );
    expect(shouldShowWindowControls({ kind: "desktop", isTauri: false })).toBe(
      false,
    );
    expect(shouldShowWindowControls({ kind: "mobile", isTauri: true })).toBe(
      false,
    );
    expect(shouldShowWindowControls(undefined)).toBe(false);
  });
});
