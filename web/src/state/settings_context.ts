// 设置 store 的 Solid Context。
//
// zoom / 主题是横切关注点,要穿过递归的 pane 树到达叶子组件
// (PaneLeaf / GridDom)。用 Context 而非逐层 prop-drilling ——
// `App` provide 一次,叶子直接 `useSettings()` 消费。

import { createContext, useContext } from "solid-js";

import type { SettingsStore } from "./settings";

export const SettingsContext = createContext<SettingsStore>();

/// 取设置 store。不在 Provider 内调用即 fail-loud(CLAUDE.md §不过度兜底)。
export function useSettings(): SettingsStore {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings 必须在 SettingsContext.Provider 内调用");
  }
  return ctx;
}
