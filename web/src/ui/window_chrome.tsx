// Desktop Tauri 自绘标题栏。只负责 OS window 行为,不承载 Perga tab 语义。

import { createSignal, type Component } from "solid-js";

import type { Platform } from "../util/platform";

export const WINDOW_CHROME_HEIGHT = 32;

type WindowAction = "close" | "minimize" | "startDragging" | "toggleMaximize";
type TauriWindow = {
  close: () => Promise<void>;
  minimize: () => Promise<void>;
  startDragging: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
};

let cachedWindow: TauriWindow | null = null;

export function shouldShowWindowChrome(platform: Platform | undefined): boolean {
  return platform?.isTauri === true && platform.kind === "desktop";
}

export type WindowChromeProps = {
  title: string;
};

export const WindowChrome: Component<WindowChromeProps> = (props) => {
  const startDrag = (e: MouseEvent): void => {
    if (e.button !== 0 || e.detail > 1) return;
    void runWindowAction("startDragging");
  };

  return (
    <div style={rootStyle}>
      <div
        style={dragRegionStyle}
        onMouseDown={startDrag}
        onDblClick={() => void runWindowAction("toggleMaximize")}
      >
        <div style={brandStyle}>Perga</div>
        <div style={titleStyle}>{props.title}</div>
      </div>
      <div style={controlsStyle}>
        <ChromeButton
          label="最小化"
          symbol="−"
          onClick={() => void runWindowAction("minimize")}
        />
        <ChromeButton
          label="最大化"
          symbol="□"
          onClick={() => void runWindowAction("toggleMaximize")}
        />
        <ChromeButton
          label="关闭"
          symbol="×"
          danger
          onClick={() => void runWindowAction("close")}
        />
      </div>
    </div>
  );
};

const ChromeButton: Component<{
  label: string;
  symbol: string;
  danger?: boolean;
  onClick: () => void;
}> = (props) => {
  const [hovered, setHovered] = createSignal(false);
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      style={buttonStyle(Boolean(props.danger), hovered())}
      onClick={props.onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {props.symbol}
    </button>
  );
};

async function runWindowAction(action: WindowAction): Promise<void> {
  try {
    const win = await currentWindow();
    await win[action]();
  } catch (e) {
    console.warn(
      `perga.window_chrome.${action}_failed`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function currentWindow(): Promise<TauriWindow> {
  if (cachedWindow) return cachedWindow;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  cachedWindow = getCurrentWindow();
  return cachedWindow;
}

const rootStyle: Record<string, string> = {
  height: `${WINDOW_CHROME_HEIGHT}px`,
  display: "flex",
  "align-items": "stretch",
  "flex-shrink": "0",
  background: "var(--pg-tabbar-bg)",
  color: "var(--term-foreground)",
  "border-bottom": "1px solid var(--pg-tabbar-border)",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  "user-select": "none",
  position: "relative",
  "z-index": "140",
};

const dragRegionStyle: Record<string, string> = {
  flex: "1",
  "min-width": "0",
  display: "flex",
  "align-items": "center",
  gap: "10px",
  padding: "0 12px",
  cursor: "default",
};

const brandStyle: Record<string, string> = {
  color: "var(--pg-accent)",
  "font-weight": "bold",
  "letter-spacing": "0",
};

const titleStyle: Record<string, string> = {
  color: "var(--pg-fg-dim)",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
};

const controlsStyle: Record<string, string> = {
  display: "flex",
  "align-items": "stretch",
  "flex-shrink": "0",
};

function buttonStyle(danger: boolean, hovered: boolean): Record<string, string> {
  return {
    width: "44px",
    height: `${WINDOW_CHROME_HEIGHT}px`,
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    border: "0",
    padding: "0",
    margin: "0",
    background: hovered
      ? danger
        ? "#c83b3b"
        : "rgba(255,255,255,0.08)"
      : "transparent",
    color: hovered && danger ? "#ffffff" : "var(--pg-fg-dim)",
    "font-family": "ui-monospace, monospace",
    "font-size": danger ? "18px" : "14px",
    "line-height": "1",
    cursor: "pointer",
  };
}
