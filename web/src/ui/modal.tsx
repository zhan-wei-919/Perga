// 通用居中模态浮层 —— 半透明 backdrop + 居中面板。
//
// 关闭时机:点击 backdrop 空白处 / Escape。面板挂载时抢 DOM 焦点,使打开模态
// 后的键盘输入不再落进背后 pane 的终端。

import { type Component, type JSX, onCleanup, onMount } from "solid-js";

export type ModalProps = {
  onClose: () => void;
  children: JSX.Element;
};

export const Modal: Component<ModalProps> = (props) => {
  let panelRef: HTMLDivElement | undefined;

  onMount(() => {
    // 抢焦点:面板拿到 DOM 焦点后,keydown 不再 bubble 经过 pane 容器 ──
    // 模态打开时终端不会误收输入。
    panelRef?.focus();
    // capture 阶段吞 Escape:先于 pane 的 keydown,且不漏进终端。
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    onCleanup(() =>
      document.removeEventListener("keydown", onKeyDown, { capture: true }),
    );
  });

  return (
    <div
      style={backdropStyle}
      onPointerDown={(e) => {
        // 仅点 backdrop 本身(非面板内部)才关闭。
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={panelRef} tabindex={-1} style={panelStyle}>
        {props.children}
      </div>
    </div>
  );
};

const backdropStyle: Record<string, string> = {
  position: "fixed",
  inset: "0",
  background: "var(--pg-backdrop)",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "z-index": "9000",
};

const panelStyle: Record<string, string> = {
  background: "var(--pg-overlay-bg)",
  border: "1px solid var(--pg-overlay-border)",
  "border-radius": "8px",
  "box-shadow": "0 12px 40px rgba(0,0,0,0.45)",
  "max-width": "90vw",
  "max-height": "85vh",
  overflow: "auto",
  color: "var(--term-foreground)",
  "font-family": "ui-monospace, monospace",
  outline: "none",
};
