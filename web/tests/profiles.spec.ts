// `state/profiles.ts` 的 fetch wrapper。本组测试的核心是 **failure 降级**:
// 网络挂 / 解析失败 / 非数组 payload,wrapper 都返回 [] 不抛错,以免在没启动
// server / 没配 hosts.toml 时把整个设置面板崩掉。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type HostProfileBody,
  ProfileApiError,
  createProfile,
  deleteProfile,
  fetchProfiles,
  updateProfile,
} from "../src/state/profiles";

const SAMPLE_BODY: HostProfileBody = {
  id: "test",
  name: "Test",
  host: "h",
  port: 22,
  user: "u",
  auth: { type: "password", password: "pw" },
};

type FetchMock = ReturnType<typeof vi.fn>;

describe("fetchProfiles", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    // 测试中 console.warn 是预期路径,静默掉避免污染输出。
    console.warn = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  it("解析成功:返回 { kind: 'ok', profiles: [...] }", async () => {
    const payload = [
      {
        id: "prod",
        name: "Prod",
        host: "h",
        port: 22,
        user: "u",
        auth_kind: "agent",
      },
    ];
    const mock: FetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => payload,
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchProfiles();
    expect(result).toEqual({ kind: "ok", profiles: payload });
    expect(mock).toHaveBeenCalledWith("/api/hosts");
  });

  it("HTTP 非 2xx → kind=error,**不是**空数组", async () => {
    const mock: FetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "parse profile file: hosts.toml:3: invalid syntax",
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchProfiles();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("HTTP 500");
      expect(result.message).toContain("parse profile file");
    }
  });

  it("payload 不是数组 → kind=error", async () => {
    const mock: FetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ not: "an array" }),
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchProfiles();
    expect(result.kind).toBe("error");
  });

  it("fetch 抛错 → kind=error", async () => {
    const mock: FetchMock = vi.fn(async () => {
      throw new Error("network");
    });
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchProfiles();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("network");
    }
  });

  it("json() 抛错 → kind=error", async () => {
    const mock: FetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error("bad json");
      },
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchProfiles();
    expect(result.kind).toBe("error");
  });

  it("空数组 = kind=ok 且 profiles 为空(没配 hosts)", async () => {
    const mock: FetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await fetchProfiles();
    expect(result).toEqual({ kind: "ok", profiles: [] });
  });
});

describe("createProfile", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POST /api/hosts with JSON body, returns summary on 2xx", async () => {
    const summary = {
      id: "test",
      name: "Test",
      host: "h",
      port: 22,
      user: "u",
      auth_kind: "password" as const,
    };
    const mock: FetchMock = vi.fn(async (_url, _init) => ({
      ok: true,
      status: 200,
      json: async () => summary,
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    const result = await createProfile(SAMPLE_BODY);
    expect(result).toEqual(summary);

    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("/api/hosts");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(SAMPLE_BODY);
  });

  it("非 2xx 抛 ProfileApiError 带 status + body", async () => {
    const mock: FetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => "profile id 'test' already exists",
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    await expect(createProfile(SAMPLE_BODY)).rejects.toBeInstanceOf(ProfileApiError);
    try {
      await createProfile(SAMPLE_BODY);
    } catch (e) {
      expect((e as ProfileApiError).status).toBe(409);
      expect((e as ProfileApiError).message).toContain("already exists");
    }
  });
});

describe("updateProfile", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("PUT /api/hosts/:id encodes id properly", async () => {
    const summary = {
      id: "weird id/with slash",
      name: "Test",
      host: "h",
      port: 22,
      user: "u",
      auth_kind: "agent" as const,
    };
    const mock: FetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => summary,
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    await updateProfile("weird id/with slash", {
      ...SAMPLE_BODY,
      id: "weird id/with slash",
    });

    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("/api/hosts/weird%20id%2Fwith%20slash");
    expect((init as RequestInit).method).toBe("PUT");
  });
});

describe("deleteProfile", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("DELETE returns void on 2xx / 204", async () => {
    const mock: FetchMock = vi.fn(async () => ({
      ok: true,
      status: 204,
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    await deleteProfile("test");

    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("/api/hosts/test");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("404 抛 ProfileApiError", async () => {
    const mock: FetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => "not found",
    }));
    globalThis.fetch = mock as unknown as typeof fetch;

    await expect(deleteProfile("ghost")).rejects.toBeInstanceOf(ProfileApiError);
  });
});
