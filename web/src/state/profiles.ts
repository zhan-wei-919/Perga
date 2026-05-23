// host profile 的客户端 API。两份实现:
//
// - `httpProfileApi` —— dev 浏览器形态,走 `perga-server` 的 `/api/hosts` REST。
// - `tauriProfileApi` —— Tauri 打包形态,走 `list_hosts` / `create_host` /
//   `update_host` / `delete_host` 四个 Tauri command。
//
// 运行时按 `isTauri()` 二选一(同 `web/src/net/index.ts` 的策略)。两边的
// 数据形态与错误前缀都对齐;调用方(settings panel / profile picker / 任何
// 后续 UI)感知不到底层差异。
//
// **GET 路径**:`fetchProfiles` 返回 discriminated union [`ProfilesResult`]:
//   - `{ kind: "ok", profiles }` —— 列表(可能空)
//   - `{ kind: "error", message }` —— 网络挂 / 后端 500 / payload 形态错。
// 区分"还没配"和"加载失败"两个状态,后者必须暴露给用户(避免 hosts.toml
// 解析错被悄悄折成空)。
//
// **写路径**(create/update/delete):失败抛 [`ProfileApiError`] —— UI 接住
// 显示 inline error。HTTP status 与 Tauri 错误前缀一一对应:
//   404 = `not_found:`、409 = `conflict:`、422 = `validation:`、500 = `io:`。

import { isTauri } from "../util/platform";

/// 后端返回的摘要(`HostProfileSummary` 的 wire 形态,**不含密码**)。
export type HostProfileSummary = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_kind: "agent" | "password";
};

/// CRUD 写路径用的完整 profile。`auth` 用 tagged enum 与后端对齐。
export type HostProfileBody = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth:
    | { type: "agent" }
    | { type: "password"; password: string };
};

export class ProfileApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProfileApiError";
  }
}

/// `fetchProfiles` 的返回类型:成功(可能含空数组)vs 错误。
export type ProfilesResult =
  | { kind: "ok"; profiles: HostProfileSummary[] }
  | { kind: "error"; message: string };

/// 客户端 API 接口。WS / Tauri 两份实现。
export interface ProfileApi {
  fetchProfiles(): Promise<ProfilesResult>;
  createProfile(body: HostProfileBody): Promise<HostProfileSummary>;
  updateProfile(id: string, body: HostProfileBody): Promise<HostProfileSummary>;
  deleteProfile(id: string): Promise<void>;
}

// ──────────────────────── HTTP 实现(perga-server)────────────────────────

const httpProfileApi: ProfileApi = {
  async fetchProfiles(): Promise<ProfilesResult> {
    try {
      const res = await fetch("/api/hosts");
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          kind: "error",
          message: body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        return {
          kind: "error",
          message: "/api/hosts returned non-array payload",
        };
      }
      return { kind: "ok", profiles: data as HostProfileSummary[] };
    } catch (e) {
      return {
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async createProfile(profile: HostProfileBody): Promise<HostProfileSummary> {
    const res = await fetch("/api/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (!res.ok) {
      throw new ProfileApiError(res.status, await readError(res));
    }
    return (await res.json()) as HostProfileSummary;
  },

  async updateProfile(
    id: string,
    profile: HostProfileBody,
  ): Promise<HostProfileSummary> {
    const res = await fetch(`/api/hosts/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (!res.ok) {
      throw new ProfileApiError(res.status, await readError(res));
    }
    return (await res.json()) as HostProfileSummary;
  },

  async deleteProfile(id: string): Promise<void> {
    const res = await fetch(`/api/hosts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      throw new ProfileApiError(res.status, await readError(res));
    }
  },
};

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ──────────────────────── Tauri 实现(打包形态)────────────────────────

/// 把 Tauri command 字符串错误的前缀映射到 HTTP status,让 UI 共用一份逻辑。
/// 前缀来自 perga-tauri 的 `profile_error_to_string` / `session_*` 错误。
function tauriErrorToStatus(s: string): { status: number; message: string } {
  if (s.startsWith("not_found:"))
    return { status: 404, message: s.slice("not_found:".length) };
  if (s.startsWith("conflict:"))
    return { status: 409, message: s.slice("conflict:".length) };
  if (s.startsWith("validation:"))
    return { status: 422, message: s.slice("validation:".length) };
  if (s.startsWith("io:"))
    return { status: 500, message: s.slice("io:".length) };
  return { status: 500, message: s };
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return (await invoke<T>(cmd, args)) as T;
  } catch (e) {
    const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    const { status, message } = tauriErrorToStatus(raw);
    throw new ProfileApiError(status, message);
  }
}

const tauriProfileApi: ProfileApi = {
  async fetchProfiles(): Promise<ProfilesResult> {
    try {
      const profiles = await tauriInvoke<HostProfileSummary[]>("list_hosts");
      return { kind: "ok", profiles };
    } catch (e) {
      return {
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  createProfile(profile) {
    return tauriInvoke<HostProfileSummary>("create_host", { profile });
  },

  updateProfile(id, profile) {
    return tauriInvoke<HostProfileSummary>("update_host", { id, profile });
  },

  async deleteProfile(id) {
    await tauriInvoke<void>("delete_host", { id });
  },
};

// ──────────────────────── 工厂选择 + 顶层导出 ────────────────────────

/// 运行时选定的实现。Tauri 形态走 IPC,浏览器形态走 HTTP。
export const profileApi: ProfileApi = isTauri() ? tauriProfileApi : httpProfileApi;

// 兼容旧调用站:settings_panel 等仍直接 import 这四个独立函数,内部转发到
// `profileApi`。后续如果觉得这层 wrapper 多余,可以直接迁到 profileApi.xxx,
// 不破 API。
export function fetchProfiles(): Promise<ProfilesResult> {
  return profileApi.fetchProfiles();
}
export function createProfile(body: HostProfileBody): Promise<HostProfileSummary> {
  return profileApi.createProfile(body);
}
export function updateProfile(
  id: string,
  body: HostProfileBody,
): Promise<HostProfileSummary> {
  return profileApi.updateProfile(id, body);
}
export function deleteProfile(id: string): Promise<void> {
  return profileApi.deleteProfile(id);
}
