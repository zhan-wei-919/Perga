// 设置面板内容 —— 缩放 / 主题。挂在 `Modal` 里。
//
// 缩放滑块:label 实时跟手,但真正提交给 settings(触发 re-measure + resize +
// Canvas 整屏重绘)做 120ms trailing debounce,避免拖动时连环重排。

import { For, type Component, createSignal } from "solid-js";

import { THEME_IDS, type ThemeId } from "../render/theme";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "../state/settings";
import { useSettings } from "../state/settings_context";

const THEME_LABELS: Record<ThemeId, string> = {
  dark: "深色",
  light: "浅色",
};

const ZOOM_COMMIT_DELAY = 120;

export const SettingsPanel: Component = () => {
  const settings = useSettings();

  // 拖动中的临时值:label 即时跟手,提交 debounce。null = 不在拖动。
  const [dragZoom, setDragZoom] = createSignal<number | null>(null);
  const shownZoom = (): number => dragZoom() ?? settings.state.zoomPercent;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  const onZoomInput = (value: number): void => {
    setDragZoom(value);
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      settings.setZoom(value);
      setDragZoom(null);
    }, ZOOM_COMMIT_DELAY);
  };

  return (
    <div style={rootStyle}>
      <div style={titleStyle}>设置</div>

      <section style={sectionStyle}>
        <div style={labelRowStyle}>
          <span>缩放</span>
          <span style={{ color: "var(--pg-fg-dim)" }}>{shownZoom()}%</span>
        </div>
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={shownZoom()}
          onInput={(e) => onZoomInput(Number(e.currentTarget.value))}
          style={{ width: "100%", "accent-color": "var(--pg-accent)" }}
        />
        <div style={hintStyle}>键盘:Ctrl+Shift+= / − / 0</div>
      </section>

      <section style={sectionStyle}>
        <div style={labelRowStyle}>
          <span>主题</span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <For each={THEME_IDS}>
            {(id) => (
              <button
                type="button"
                style={choiceStyle(settings.state.themeId === id)}
                onClick={() => settings.setTheme(id)}
              >
                {THEME_LABELS[id]}
              </button>
            )}
          </For>
        </div>
      </section>
    </div>
  );
};

const rootStyle: Record<string, string> = {
  padding: "18px 20px",
  "min-width": "340px",
  "font-size": "13px",
};

const titleStyle: Record<string, string> = {
  "font-size": "15px",
  "font-weight": "bold",
  "margin-bottom": "16px",
};

const sectionStyle: Record<string, string> = {
  "margin-bottom": "18px",
};

const labelRowStyle: Record<string, string> = {
  display: "flex",
  "justify-content": "space-between",
  "margin-bottom": "8px",
};

const hintStyle: Record<string, string> = {
  color: "var(--pg-fg-dim)",
  "font-size": "11px",
  "margin-top": "4px",
};

/// 单选项按钮(等宽平分)。
function choiceStyle(active: boolean): Record<string, string> {
  return {
    flex: "1",
    display: "flex",
    "flex-direction": "column",
    "align-items": "flex-start",
    gap: "2px",
    padding: "8px 10px",
    "text-align": "left",
    "font-family": "ui-monospace, monospace",
    "font-size": "13px",
    cursor: "pointer",
    "border-radius": "5px",
    border: active
      ? "1px solid var(--pg-accent)"
      : "1px solid var(--pg-overlay-border)",
    background: active ? "var(--pg-overlay-hover)" : "transparent",
    color: "var(--term-foreground)",
  };
}
