// Platform 探测 —— 前端唯一一处决定「桌面 vs 移动端」的源头。
//
// 三层 fallback:
// 1. URL flag `?platform=mobile` —— 开发期在浏览器里强制开启移动端 UX,
//    不必跑 Tauri / 真机也能验证 `+` 弹 picker、首次启动引导等路径。
// 2. Tauri 探测 `__TAURI_INTERNALS__` —— 在 Tauri 形态里调
//    `get_platform_info` command 拿 OS 信息。Android/iOS → mobile,其余 → desktop。
// 3. 默认 desktop。
//
// 不做 navigator.userAgent / maxTouchPoints 嗅探 —— 浏览器 dev 默认就是
// desktop;真要测移动端要么用 URL flag,要么打包 Tauri 跑真机。
// 嗅探会把"在平板上开浏览器调试 Perga"这种边角场景也判成 mobile,反而不利。

export type Platform = {
  kind: "desktop" | "mobile";
  isTauri: boolean;
};

/// 检测是否运行在 Tauri webview 里。同步 + 无副作用。
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

/// 解析当前平台。在 Tauri 形态下调 `get_platform_info` command;浏览器
/// 形态下读 `?platform=` URL flag。
export async function detectPlatform(): Promise<Platform> {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("platform") === "mobile") {
      return { kind: "mobile", isTauri: false };
    }
    if (params.get("platform") === "desktop") {
      return { kind: "desktop", isTauri: false };
    }
  }
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<{ kind: "desktop" | "mobile"; os: string }>(
        "get_platform_info",
      );
      return { kind: info.kind, isTauri: true };
    } catch (e) {
      // get_platform_info 不应失败 —— 失败也降级为 desktop,继续可用。
      console.warn(
        "perga.platform.get_platform_info_failed",
        e instanceof Error ? e.message : String(e),
      );
      return { kind: "desktop", isTauri: true };
    }
  }
  return { kind: "desktop", isTauri: false };
}
