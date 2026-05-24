// 顶栏:tabs + 拖拽区 + 设置 + (Tauri desktop) 窗口控制 合一栏。wezterm
// 风格的常显 tab 栏。
//
// 跨平台行为差异都收在这一个组件里:
// - mobile / 浏览器:tabs + + + ⚙,无 drag 区、无窗口控制
// - 浏览器(非 Tauri)desktop:同上
// - Tauri desktop:tabs + + + 拖拽区 + ⚙ + 窗口控制(min/max/close)
//
// 拖拽区是 flex spacer,占满中间剩余宽度;按下 mousedown 调
// `getCurrentWindow().startDragging()`,双击 toggle 最大化。

import { type Component, For, Show, createSignal } from "solid-js";

import type { Workspace } from "../state/workspace";
import type { Platform } from "../util/platform";

export const TOP_BAR_HEIGHT = 36;

/// 是否在窗口顶栏展示 OS 控制(最小化 / 最大化 / 关闭)。
/// 仅 Tauri desktop 自绘窗口需要;浏览器和移动端走系统/容器原生 chrome。
export function shouldShowWindowControls(
  platform: Platform | undefined,
): boolean {
  return platform?.isTauri === true && platform.kind === "desktop";
}

export type TopBarProps = {
  workspace: Workspace;
  platform: Platform | undefined;
  onOpenSettings: () => void;
  /// 平台覆盖:移动端 + 传入「打开 profile picker」,desktop 不传 = 默认本地 shell。
  onPlusOverride?: () => void;
};

export const TopBar: Component<TopBarProps> = (props) => {
  const ws = props.workspace;
  const showControls = (): boolean => shouldShowWindowControls(props.platform);
  const handlePlus = (): void => {
    if (props.onPlusOverride) props.onPlusOverride();
    else ws.newTab();
  };
  return (
    <div style={rootStyle()}>
      <div style={tabsRowStyle}>
        <For each={ws.state.tabs}>
          {(tab, index) => (
            <TabChip
              label={ws.tabTitle(tab.id)}
              active={index() === ws.state.activeTab}
              onSelect={() => ws.switchTab(index())}
              onClose={() => ws.closeTab(tab.id)}
            />
          )}
        </For>
        <IconButton title="新建 tab" onClick={handlePlus}>
          <PlusIcon />
        </IconButton>
      </div>
      <DragRegion enabled={showControls()} />
      <IconButton title="设置" onClick={props.onOpenSettings}>
        <GearIcon />
      </IconButton>
      <Show when={showControls()}>
        <WindowControls />
      </Show>
    </div>
  );
};

const TabChip: Component<{
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}> = (props) => {
  const [hovered, setHovered] = createSignal(false);
  return (
    <div
      style={tabChipStyle(props.active, hovered())}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={props.onSelect}
    >
      {/* active tab 顶部 2px accent 条 ── wezterm 风的状态指示;比换底色更
          轻量、对主题切换无感。 */}
      <Show when={props.active}>
        <div style={tabAccentStyle} />
      </Show>
      <span style={tabLabelStyle}>{props.label}</span>
      <span
        style={tabCloseStyle}
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        title="关闭"
      >
        ×
      </span>
    </div>
  );
};

/// 拖拽区。Tauri desktop 下 mousedown 起拖、dblclick 最大化;
/// 其余平台仍占满中间空间,但作为普通 flex spacer。
const DragRegion: Component<{ enabled: boolean }> = (props) => {
  const startDrag = (e: MouseEvent): void => {
    if (!props.enabled) return;
    if (e.button !== 0 || e.detail > 1) return;
    void runWindowAction("startDragging");
  };
  const toggleMax = (): void => {
    if (!props.enabled) return;
    void runWindowAction("toggleMaximize");
  };
  return (
    <div
      style={dragRegionStyle(props.enabled)}
      onMouseDown={startDrag}
      onDblClick={toggleMax}
    />
  );
};

const WindowControls: Component = () => (
  <div style={controlsGroupStyle}>
    <ChromeButton
      label="最小化"
      onClick={() => void runWindowAction("minimize")}
    >
      <MinimizeIcon />
    </ChromeButton>
    <ChromeButton
      label="最大化"
      onClick={() => void runWindowAction("toggleMaximize")}
    >
      <MaximizeIcon />
    </ChromeButton>
    <ChromeButton
      label="关闭"
      danger
      onClick={() => void runWindowAction("close")}
    >
      <CloseIcon />
    </ChromeButton>
  </div>
);

const ChromeButton: Component<{
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: any;
}> = (props) => {
  const [hovered, setHovered] = createSignal(false);
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      style={chromeButtonStyle(Boolean(props.danger), hovered())}
      onClick={props.onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {props.children}
    </button>
  );
};

const IconButton: Component<{
  title: string;
  onClick: () => void;
  children: any;
}> = (props) => {
  const [hovered, setHovered] = createSignal(false);
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      style={iconButtonStyle(hovered())}
      onClick={props.onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {props.children}
    </button>
  );
};

// --- SVG icons. 14x14 viewBox,currentColor 跟随按钮文本色,主题切换自适应。

const MinimizeIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <line
      x1="2.5"
      y1="7"
      x2="11.5"
      y2="7"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
    />
  </svg>
);

const MaximizeIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <rect
      x="2.8"
      y="2.8"
      width="8.4"
      height="8.4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      rx="0.6"
    />
  </svg>
);

const CloseIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <line
      x1="3"
      y1="3"
      x2="11"
      y2="11"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
    <line
      x1="11"
      y1="3"
      x2="3"
      y2="11"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>
);

const PlusIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <line
      x1="7"
      y1="2.5"
      x2="7"
      y2="11.5"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
    <line
      x1="2.5"
      y1="7"
      x2="11.5"
      y2="7"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>
);

const GearIcon: Component = () => (
  // 简化 cog:外圈 8 齿椭圆 + 中心孔。SVG path 直出,不引第三方图标库。
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M7 2.4l0.6 1.2 1.3 0.1 0.4 1.2 1.1 0.7-0.2 1.3 0.7 1.1-0.7 1.1 0.2 1.3-1.1 0.7-0.4 1.2-1.3 0.1L7 11.6l-0.6-1.2-1.3-0.1-0.4-1.2-1.1-0.7 0.2-1.3-0.7-1.1 0.7-1.1-0.2-1.3 1.1-0.7 0.4-1.2 1.3-0.1z"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linejoin="round"
    />
    <circle
      cx="7"
      cy="7"
      r="1.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
    />
  </svg>
);

// --- Tauri window 桥。lazy import,非 Tauri 形态不引入。

type TauriWindow = {
  close: () => Promise<void>;
  minimize: () => Promise<void>;
  startDragging: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
};

let cachedWindow: TauriWindow | null = null;

type WindowAction = "close" | "minimize" | "startDragging" | "toggleMaximize";

async function runWindowAction(action: WindowAction): Promise<void> {
  try {
    const win = await currentWindow();
    await win[action]();
  } catch (e) {
    console.warn(
      `perga.top_bar.${action}_failed`,
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

// --- styles

function rootStyle(): Record<string, string> {
  return {
    height: `${TOP_BAR_HEIGHT}px`,
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
}

const tabsRowStyle: Record<string, string> = {
  display: "flex",
  "align-items": "stretch",
  "flex-shrink": "0",
};

function tabChipStyle(
  active: boolean,
  hovered: boolean,
): Record<string, string> {
  // active = 跟 pane 同色融为一体;inactive = 略压暗;hover 略亮,
  // 用 overlay tint(rgba)而不是切色 ── 任何主题下都自然。
  const bg = active
    ? "var(--pg-tab-active-bg)"
    : hovered
      ? "var(--pg-overlay-hover)"
      : "var(--pg-tab-inactive-bg)";
  const fg = active
    ? "var(--pg-tab-active-fg)"
    : "var(--pg-tab-inactive-fg)";
  return {
    position: "relative",
    display: "flex",
    "align-items": "center",
    gap: "8px",
    padding: "0 12px 0 14px",
    "min-width": "100px",
    "max-width": "220px",
    background: bg,
    color: fg,
    "border-right": "1px solid var(--pg-tabbar-border)",
    cursor: "pointer",
    transition: "background 0.1s ease",
  };
}

const tabAccentStyle: Record<string, string> = {
  position: "absolute",
  top: "0",
  left: "0",
  right: "0",
  height: "2px",
  background: "var(--pg-accent)",
};

const tabLabelStyle: Record<string, string> = {
  flex: "1",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
  "min-width": "0",
};

const tabCloseStyle: Record<string, string> = {
  color: "var(--pg-fg-dim)",
  "font-size": "14px",
  "line-height": "1",
  padding: "0 2px",
  cursor: "pointer",
};

function dragRegionStyle(enabled: boolean): Record<string, string> {
  return {
    flex: "1",
    "min-width": "0",
    cursor: enabled ? "default" : "auto",
  };
}

const controlsGroupStyle: Record<string, string> = {
  display: "flex",
  "align-items": "stretch",
  "flex-shrink": "0",
};

function chromeButtonStyle(
  danger: boolean,
  hovered: boolean,
): Record<string, string> {
  return {
    width: "44px",
    height: `${TOP_BAR_HEIGHT}px`,
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    border: "0",
    padding: "0",
    margin: "0",
    background: hovered
      ? danger
        ? "#c83b3b"
        : "var(--pg-overlay-hover)"
      : "transparent",
    color: hovered && danger ? "#ffffff" : "var(--pg-fg-dim)",
    cursor: "pointer",
    transition: "background 0.1s ease, color 0.1s ease",
  };
}

function iconButtonStyle(hovered: boolean = false): Record<string, string> {
  return {
    width: `${TOP_BAR_HEIGHT}px`,
    height: `${TOP_BAR_HEIGHT}px`,
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    border: "0",
    padding: "0",
    margin: "0",
    background: hovered ? "var(--pg-overlay-hover)" : "transparent",
    color: "var(--pg-fg-dim)",
    cursor: "pointer",
    "flex-shrink": "0",
    transition: "background 0.1s ease",
  };
}
