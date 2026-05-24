// IME / soft-keyboard committed text handling.

import { describe, expect, it } from "vitest";

import {
  compositionCommitMessage,
  inputCommitMessage,
  textInputMessage,
} from "../src/input/composition";

describe("compositionCommitMessage", () => {
  it("uses compositionend data when available", () => {
    expect(compositionCommitMessage("中文", "zhongwen")).toEqual({
      type: "paste",
      text: "中文",
    });
  });

  it("falls back to input value when compositionend data is empty", () => {
    expect(compositionCommitMessage("", "你好")).toEqual({
      type: "paste",
      text: "你好",
    });
  });

  it("drops empty commits", () => {
    expect(compositionCommitMessage("", "")).toBeNull();
  });
});

describe("inputCommitMessage", () => {
  it("uses textarea value when it is available", () => {
    expect(inputCommitMessage("x", "中文")).toEqual({
      type: "paste",
      text: "中文",
    });
  });

  it("falls back to InputEvent.data when textarea value is empty", () => {
    expect(inputCommitMessage("你", "")).toEqual({
      type: "paste",
      text: "你",
    });
  });

  it("drops empty input commits", () => {
    expect(inputCommitMessage(null, "")).toBeNull();
  });
});

describe("textInputMessage", () => {
  it("turns committed text into a paste message", () => {
    expect(textInputMessage("かな")).toEqual({ type: "paste", text: "かな" });
  });

  it("drops empty text", () => {
    expect(textInputMessage("")).toBeNull();
  });
});
