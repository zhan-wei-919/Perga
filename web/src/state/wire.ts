// 出站消息(client → server)的 wire 类型,与 perga-server `ClientMessage` 对齐。
//
// 接收端在 Rust 那一侧用 `serde(tag = "type")`,这里就保持 snake_case 字面量。

export type Modifiers = {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export type FunctionN = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type KeyValue =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "backspace" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "page_up" }
  | { type: "page_down" }
  | { type: "insert" }
  | { type: "delete" }
  | { type: "f"; n: FunctionN };

export type MouseButton = "left" | "middle" | "right";

export type MouseKind =
  | { type: "press"; button: MouseButton }
  | { type: "release"; button: MouseButton }
  | { type: "drag"; button: MouseButton }
  | { type: "motion" }
  | { type: "wheel_up" }
  | { type: "wheel_down" };

export type ClientMessage =
  | { type: "key"; key: KeyValue; mods?: Modifiers }
  | { type: "paste"; text: string }
  // mouse / focus 在 Phase 1 不接,留 type alias 让后续接入零摩擦。
  | { type: "mouse"; kind: MouseKind; col: number; row: number; mods?: Modifiers }
  | { type: "focus"; gained: boolean }
  | { type: "resize"; rows: number; cols: number };
