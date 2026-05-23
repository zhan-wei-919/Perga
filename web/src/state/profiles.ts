// host profile 的 fetch wrappers(GET / POST / PUT / DELETE)。
//
// **GET 路径**:返回 discriminated union [`ProfilesResult`]:
//   - `{ kind: "ok", profiles }` —— 正常拉到列表(可能是空数组,代表"没配主机")
//   - `{ kind: "error", message }` —— 网络挂 / server 500 / payload 形态错。
// UI 用 `kind` 区分"还没配"和"加载失败" —— 后者必须暴露给用户,否则
// `hosts.toml` 解析错(toml 格式 bug)会被悄悄折成空状态,用户以为没配主机。
//
// **写路径**(POST / PUT / DELETE):失败抛 `ProfileApiError`(带 HTTP status
// + message),由 UI 接住转成 inline error。这些是用户主动操作,静默失败比
// 抛错更糟。

/// 后端返回的摘要(`HostProfileSummary` 的 wire 形态,**不含密码**)。
/// `auth_kind` 用来在 UI 上显示 icon / label,真正的密码只在 POST/PUT body 里
/// 单向流入,**永远不**从 GET 返回。
export type HostProfileSummary = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_kind: "agent" | "password";
};

/// CRUD 写路径用的完整 profile。`auth` 用 tagged enum 与后端对齐;`password`
/// 字段仅在 `auth.type === "password"` 时存在。
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

/// `fetchProfiles` 的返回类型:成功(可能含空数组)vs 错误。区分"没配主机"
/// 和"加载失败"这两个之前会被合并的状态。
export type ProfilesResult =
  | { kind: "ok"; profiles: HostProfileSummary[] }
  | { kind: "error"; message: string };

/// 拉取 host profile 列表。**不抛错** —— 错误折进 `ProfilesResult`,UI 用
/// `kind` 分情况渲染。
export async function fetchProfiles(): Promise<ProfilesResult> {
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
}

/// 创建一个新 profile。失败抛 `ProfileApiError`(409 = id 已存在,
/// 422 = 字段校验失败,500 = IO / toml 错)。
export async function createProfile(
  profile: HostProfileBody,
): Promise<HostProfileSummary> {
  const res = await fetch("/api/hosts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    throw new ProfileApiError(res.status, await readError(res));
  }
  return (await res.json()) as HostProfileSummary;
}

/// 更新已有 profile。`id` 必须与 `profile.id` 一致 —— 后端拒绝改 id。
export async function updateProfile(
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
}

/// 删除一个 profile。成功 = 204;失败抛 `ProfileApiError`。
export async function deleteProfile(id: string): Promise<void> {
  const res = await fetch(`/api/hosts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new ProfileApiError(res.status, await readError(res));
  }
}

/// 把 server 返回的错误 body(纯文本)读出来。失败也降级到 status 文字。
async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
