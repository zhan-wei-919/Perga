// 用户设置 —— 缩放 / 主题 / 字体,持久化到 localStorage。
//
// 边界验证只在这里做一次:`parseSettings` 把 localStorage 里可能被手改、跨版本
// 漂移的原始字符串解析成干净的 `Settings`,逐字段独立兜底回默认。下游信任它。
// 不写版本号 / 迁移 —— 当前没有旧数据格式(「不为未来写代码」)。

import { createStore } from "solid-js/store";

import { FONT_IDS, type FontId, fontFamilyFor } from "../render/fonts";
import { THEME_IDS, type ThemeId } from "../render/theme";

export type Settings = {
  /** 缩放百分比,[50,200] 步进 10。 */
  zoomPercent: number;
  themeId: ThemeId;
  fontId: FontId;
};

/// 基准字号(CSS 像素)。有效字号 = BASE_FONT_SIZE × zoomPercent / 100。
export const BASE_FONT_SIZE = 16;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_STEP = 10;

const STORAGE_KEY = "perga.settings";
const DEFAULTS: Settings = {
  zoomPercent: 100,
  themeId: "dark",
  fontId: "default",
};

const VALID_THEME_IDS = new Set<string>(THEME_IDS);
const VALID_FONT_IDS = new Set<string>(FONT_IDS);

/// 夹到 [ZOOM_MIN, ZOOM_MAX] 并吸附到步进。非有限数 → 默认 100。
export function clampZoom(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULTS.zoomPercent;
  const snapped = Math.round(pct / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped));
}

/// 解析持久化的 settings。`null` / 坏 JSON / 字段非法 → 各自回落默认。
export function parseSettings(raw: string | null): Settings {
  if (raw === null) return { ...DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };
  const o = parsed as Record<string, unknown>;
  return {
    zoomPercent:
      typeof o.zoomPercent === "number"
        ? clampZoom(o.zoomPercent)
        : DEFAULTS.zoomPercent,
    themeId:
      typeof o.themeId === "string" && VALID_THEME_IDS.has(o.themeId)
        ? (o.themeId as ThemeId)
        : DEFAULTS.themeId,
    fontId:
      typeof o.fontId === "string" && VALID_FONT_IDS.has(o.fontId)
        ? (o.fontId as FontId)
        : DEFAULTS.fontId,
  };
}

/// 设置 store:响应式 `state` + 变更方法(每次变更即持久化)。
export type SettingsStore = {
  state: Settings;
  /** 当前有效字号(CSS 像素),响应式。 */
  effectiveFontSize: () => number;
  /** 当前终端字体栈,响应式。 */
  fontFamily: () => string;
  setZoom: (pct: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  setTheme: (id: ThemeId) => void;
  setFont: (id: FontId) => void;
};

/// 建设置 store。启动时从 localStorage 读取并校验。
export function createSettings(): SettingsStore {
  const [state, setState] = createStore<Settings>(parseSettings(readRaw()));

  const persist = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 私密模式 / 配额满 —— 静默,设置仍在内存生效。
    }
  };

  const setZoom = (pct: number): void => {
    setState("zoomPercent", clampZoom(pct));
    persist();
  };

  return {
    state,
    effectiveFontSize: () =>
      Math.round((BASE_FONT_SIZE * state.zoomPercent) / 100),
    fontFamily: () => fontFamilyFor(state.fontId),
    setZoom,
    zoomIn: () => setZoom(state.zoomPercent + ZOOM_STEP),
    zoomOut: () => setZoom(state.zoomPercent - ZOOM_STEP),
    zoomReset: () => setZoom(100),
    setTheme: (id) => {
      setState("themeId", id);
      persist();
    },
    setFont: (id) => {
      setState("fontId", id);
      persist();
    },
  };
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
