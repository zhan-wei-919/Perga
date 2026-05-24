// IME / soft-keyboard committed text -> ClientMessage.
//
// Keydown only tells us "composition is happening"; the committed text arrives
// through composition/input events. Treat the committed string like paste so
// PTY and SSH reuse the same UTF-8 path and bracketed-paste protection.

import type { ClientMessage } from "../state/wire";

type PasteMessage = Extract<ClientMessage, { type: "paste" }>;

export function compositionCommitMessage(
  eventData: string,
  fallbackValue: string,
): PasteMessage | null {
  return textInputMessage(eventData.length > 0 ? eventData : fallbackValue);
}

export function inputCommitMessage(
  eventData: string | null,
  fallbackValue: string,
): PasteMessage | null {
  return textInputMessage(
    fallbackValue.length > 0 ? fallbackValue : eventData ?? "",
  );
}

export function textInputMessage(text: string): PasteMessage | null {
  if (text.length === 0) return null;
  return { type: "paste", text };
}
