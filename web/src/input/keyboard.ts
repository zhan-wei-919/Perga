// 浏览器 KeyboardEvent → 后端 ClientMessage(`key`)。
//
// 这一层只做**语义化**:把 DOM 的 key/keyCode/code 归一化成
// `terminal-input::KeyEvent`。具体怎么编成 PTY 字节(application cursor 下
// 方向键不同 / Ctrl+C 编成 0x03 / etc)全部留给后端 ── 后端知道当前 modes,
// 前端不该重复实现一份。

import type { ClientMessage, FunctionN, KeyValue, Modifiers } from "../state/wire";

/// 主入口。返回 null 表示这个事件不构成可发送的键(例如 IME 合成中、Dead key、
/// 修饰键单独按下),调用方收到 null 应**不** preventDefault,让浏览器走默认
/// 路径(IME 候选框、辅助技术等)。
export function encodeKeyboardEvent(e: KeyboardEvent): ClientMessage | null {
  // IME 合成期间 key 是 "Process"。这种事件不该发到 PTY,等 compositionend
  // 再触发 paste 风格的整段输入。
  if (e.isComposing || e.key === "Process") return null;

  // 单独按下修饰键也会触发 keydown,但 key === "Shift" / "Control" / etc。
  // 这些不构成终端字节,直接忽略。
  if (isModifierKey(e.key)) return null;

  const key = mapKey(e);
  if (!key) return null;

  const mods = collectMods(e);
  return {
    type: "key",
    key,
    // 全 false 时省略,wire 形状更紧凑。
    mods: anyMod(mods) ? mods : undefined,
  };
}

function mapKey(e: KeyboardEvent): KeyValue | null {
  switch (e.key) {
    case "Enter":
      return { type: "enter" };
    case "Tab":
      return { type: "tab" };
    case "Backspace":
      return { type: "backspace" };
    case "Escape":
      return { type: "escape" };
    case "ArrowUp":
      return { type: "up" };
    case "ArrowDown":
      return { type: "down" };
    case "ArrowLeft":
      return { type: "left" };
    case "ArrowRight":
      return { type: "right" };
    case "Home":
      return { type: "home" };
    case "End":
      return { type: "end" };
    case "PageUp":
      return { type: "page_up" };
    case "PageDown":
      return { type: "page_down" };
    case "Insert":
      return { type: "insert" };
    case "Delete":
      return { type: "delete" };
  }

  // F1..F12。e.key 在所有现代浏览器都是 "F1" / "F12"。
  if (e.key.length >= 2 && e.key[0] === "F") {
    const n = Number.parseInt(e.key.slice(1), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 12) {
      return { type: "f", n: n as FunctionN };
    }
    // F13+ 或其他奇异键:丢弃,后端 schema 拒绝 > 12。
    return null;
  }

  // 印刷字符 / 已合成 IME 结果。key.length 在大多数现代浏览器对单 codepoint
  // 字符 = 1,emoji 等多 codepoint 可能 = 2(surrogate pair)── 我们只取
  // length === 1 的情况,避免把 IME 合成中间态当输入。emoji 输入走 paste 路径。
  if (e.key.length === 1) {
    return { type: "char", value: e.key };
  }

  return null;
}

function collectMods(e: KeyboardEvent): Modifiers {
  // metaKey(macOS Cmd / Windows 键)在终端协议里没有标准编码,后端
  // `terminal-input::Modifiers` 也故意不暴露 meta。这里把它丢掉:
  // 不映射到 ctrl ── 那会让 Cmd+C(浏览器复制)被吞,UX 灾难。
  return {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
  };
}

function anyMod(m: Modifiers): boolean {
  return Boolean(m.ctrl || m.alt || m.shift);
}

const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  // Dead key(IME 死键)── compositionend 时再发整段。
  "Dead",
]);

function isModifierKey(k: string): boolean {
  return MODIFIER_KEYS.has(k);
}
