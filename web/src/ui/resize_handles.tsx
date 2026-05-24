// Tauri desktop 自绘窗口的边缘 resize 区。
//
// 自绘窗口没有 OS 默认的可拖拽窗框 ── 用户拖边/角 resize 必须前端自己接。
// 八个透明 div 贴在窗口四边四角,接 mousedown → 调
// `getCurrentWindow().startResizeDragging(direction)`。
//
// 厚度比例:边 6px、角 12x12。比浏览器默认 1px 拖拽区宽得多 ── 自绘窗口
// 没有 OS 提示边框,得让用户「能看不见也能精准命中」。
// 角的 z-index 比边稍高,保证角落区域优先触发对角线 resize。

import { type Component } from "solid-js";

type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const EDGE_THICKNESS = 6;
const CORNER_SIZE = 12;

export const ResizeHandles: Component = () => (
  <>
    <ResizeHandle direction="North" style={northStyle} />
    <ResizeHandle direction="South" style={southStyle} />
    <ResizeHandle direction="West" style={westStyle} />
    <ResizeHandle direction="East" style={eastStyle} />
    <ResizeHandle direction="NorthWest" style={cornerStyle("nw")} />
    <ResizeHandle direction="NorthEast" style={cornerStyle("ne")} />
    <ResizeHandle direction="SouthWest" style={cornerStyle("sw")} />
    <ResizeHandle direction="SouthEast" style={cornerStyle("se")} />
  </>
);

const ResizeHandle: Component<{
  direction: ResizeDirection;
  style: Record<string, string>;
}> = (props) => {
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    void startResize(props.direction);
  };
  return <div style={props.style} onPointerDown={onPointerDown} />;
};

async function startResize(direction: ResizeDirection): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    // startResizeDragging 的 direction 是 enum-like 字符串;Tauri 2 接受
    // "North" / "East" / ... 字面量。
    await (win as unknown as {
      startResizeDragging: (d: ResizeDirection) => Promise<void>;
    }).startResizeDragging(direction);
  } catch (e) {
    console.warn(
      `perga.resize.start_${direction}_failed`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

// --- 边样式。绝对定位贴满 root,corner 之间留给角 handle,免得鼠标在角
// 落区只触发到边 handle。
//
// z-index 8000 选在 TopBar(140) 之上、modal(9000) / perf_overlay(9999) 之
// 下 ── modal 打开时鼠标拖窗口边不应触发 resize(用户在跟 modal 交互)。

const baseHandle: Record<string, string> = {
  position: "absolute",
  "z-index": "8000",
};

const northStyle: Record<string, string> = {
  ...baseHandle,
  top: "0",
  left: `${CORNER_SIZE}px`,
  right: `${CORNER_SIZE}px`,
  height: `${EDGE_THICKNESS}px`,
  cursor: "ns-resize",
};

const southStyle: Record<string, string> = {
  ...baseHandle,
  bottom: "0",
  left: `${CORNER_SIZE}px`,
  right: `${CORNER_SIZE}px`,
  height: `${EDGE_THICKNESS}px`,
  cursor: "ns-resize",
};

const westStyle: Record<string, string> = {
  ...baseHandle,
  left: "0",
  top: `${CORNER_SIZE}px`,
  bottom: `${CORNER_SIZE}px`,
  width: `${EDGE_THICKNESS}px`,
  cursor: "ew-resize",
};

const eastStyle: Record<string, string> = {
  ...baseHandle,
  right: "0",
  top: `${CORNER_SIZE}px`,
  bottom: `${CORNER_SIZE}px`,
  width: `${EDGE_THICKNESS}px`,
  cursor: "ew-resize",
};

function cornerStyle(pos: "nw" | "ne" | "sw" | "se"): Record<string, string> {
  const base: Record<string, string> = {
    ...baseHandle,
    "z-index": "8001",
    width: `${CORNER_SIZE}px`,
    height: `${CORNER_SIZE}px`,
  };
  if (pos === "nw") return { ...base, top: "0", left: "0", cursor: "nwse-resize" };
  if (pos === "ne") return { ...base, top: "0", right: "0", cursor: "nesw-resize" };
  if (pos === "sw") return { ...base, bottom: "0", left: "0", cursor: "nesw-resize" };
  return { ...base, bottom: "0", right: "0", cursor: "nwse-resize" };
}
