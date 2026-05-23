// 移动端 + 按钮 / 首次启动引导用的 profile picker。
//
// 两种调用方式:
// 1. 普通选择(`forceSetup = false`):列出 profile,点一个 → connect。
//    也可以「+ 添加新主机」进入 HostForm 添加,完成后回到列表。
//    用户可点 Cancel / 关 Modal 退出而不选。
// 2. 首次启动引导(`forceSetup = true`):0 profile 时**强制**进入 HostForm,
//    保存后立即连接。Cancel 按钮替换为「先不连接」(allow exit without picking)
//    —— 保留一个出口避免 0 profile 死循环。

import {
  type Component,
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
} from "solid-js";

import {
  type HostProfileBody,
  type HostProfileSummary,
  ProfileApiError,
  createProfile,
  fetchProfiles,
} from "../state/profiles";
import { HostForm, emptyProfile } from "./host_form";

export type ProfilePickerProps = {
  /// 用户选了 / 创建了一个 profile;父层负责开新 tab + 关 modal。
  onConnect: (profileId: string) => void;
  /// 用户取消 / 点 backdrop。`forceSetup = true` 时仍允许 — 0 profile 的初次引导
  /// 不应该把用户卡死,Cancel 等于「先不连,我直接 close modal」。
  onCancel: () => void;
  /// true = 首次启动引导(无 profile),自动进入 form,提交即连接。
  forceSetup?: boolean;
};

export const ProfilePicker: Component<ProfilePickerProps> = (props) => {
  const [profilesResult, { refetch }] = createResource(fetchProfiles);
  const [adding, setAdding] = createSignal(false);
  const [opError, setOpError] = createSignal<string | null>(null);

  // 0 profile + forceSetup → 自动进入 add 模式。createEffect 跟着 resource 触发。
  createEffect(() => {
    const r = profilesResult();
    if (props.forceSetup && r?.kind === "ok" && r.profiles.length === 0) {
      setAdding(true);
    }
  });

  const profiles = (): HostProfileSummary[] => {
    const r = profilesResult();
    return r?.kind === "ok" ? r.profiles : [];
  };
  const loadError = (): string | null => {
    const r = profilesResult();
    return r?.kind === "error" ? r.message : null;
  };

  const onAdd = async (body: HostProfileBody): Promise<void> => {
    setOpError(null);
    try {
      const created = await createProfile(body);
      setAdding(false);
      await refetch();
      // 引导模式:新建即连接;普通模式:返回列表让用户选。
      if (props.forceSetup) {
        props.onConnect(created.id);
      }
    } catch (e) {
      setOpError(
        e instanceof ProfileApiError
          ? `${e.message} (HTTP ${e.status})`
          : String(e),
      );
    }
  };

  return (
    <div style={rootStyle}>
      <div style={titleStyle}>
        <Show
          when={props.forceSetup && profiles().length === 0}
          fallback="选择远程主机"
        >
          添加第一台远程主机
        </Show>
      </div>

      <Show when={loadError()}>
        <div style={errorStyle}>
          <div style={{ "font-weight": "bold", "margin-bottom": "4px" }}>
            加载主机列表失败
          </div>
          <div style={{ "font-size": "11px", "white-space": "pre-wrap" }}>
            {loadError()}
          </div>
        </div>
      </Show>

      <Show when={opError()}>
        <div style={errorStyle}>{opError()}</div>
      </Show>

      <Show when={adding()}>
        <HostForm
          initial={emptyProfile()}
          onSubmit={onAdd}
          onCancel={() => {
            // 首次引导 + 0 profile 时取消 = 关掉整个 picker(由父层决定要不要
            // 让用户先不连接)。普通模式取消 = 退回列表。
            if (props.forceSetup && profiles().length === 0) {
              props.onCancel();
            } else {
              setAdding(false);
              setOpError(null);
            }
          }}
          submitLabel={props.forceSetup ? "添加并连接" : "保存"}
        />
      </Show>

      <Show when={!adding()}>
        <Show
          when={profiles().length > 0}
          fallback={
            <Show when={!loadError()}>
              <div style={hintStyle}>
                还没有配置远程主机。点下面的按钮添加第一台。
              </div>
            </Show>
          }
        >
          <div style={listStyle}>
            <For each={profiles()}>
              {(p) => (
                <button
                  type="button"
                  style={hostButtonStyle}
                  onClick={() => props.onConnect(p.id)}
                >
                  <div style={hostNameStyle}>
                    {p.name}
                    <span style={authBadgeStyle(p.auth_kind)}>
                      {p.auth_kind === "password" ? "🔒" : "🔑"}
                    </span>
                  </div>
                  <div style={hostMetaStyle}>
                    {`${p.user}@${p.host}:${p.port}`}
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>

        <div style={actionsStyle}>
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={props.onCancel}
          >
            {props.forceSetup ? "先不连接" : "取消"}
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => {
              setOpError(null);
              setAdding(true);
            }}
          >
            + 添加新主机
          </button>
        </div>
      </Show>
    </div>
  );
};

// ─────────────────── styles ───────────────────

const rootStyle: Record<string, string> = {
  padding: "20px 22px",
  "min-width": "320px",
  "max-width": "480px",
  "font-size": "13px",
};

const titleStyle: Record<string, string> = {
  "font-size": "15px",
  "font-weight": "bold",
  "margin-bottom": "14px",
};

const hintStyle: Record<string, string> = {
  color: "var(--pg-fg-dim)",
  "font-size": "12px",
  "margin-bottom": "12px",
};

const errorStyle: Record<string, string> = {
  color: "#ff6b6b",
  "font-size": "12px",
  "margin-bottom": "10px",
  padding: "8px 10px",
  "border-radius": "4px",
  border: "1px solid #ff6b6b",
  background: "rgba(255,107,107,0.08)",
};

const listStyle: Record<string, string> = {
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  "margin-bottom": "12px",
};

/// 大块 tap target(平板触控友好):整行可点,左对齐多行内容。
const hostButtonStyle: Record<string, string> = {
  display: "flex",
  "flex-direction": "column",
  "align-items": "flex-start",
  gap: "4px",
  padding: "12px 14px",
  "text-align": "left",
  "font-family": "ui-monospace, monospace",
  "font-size": "13px",
  cursor: "pointer",
  "border-radius": "6px",
  border: "1px solid var(--pg-overlay-border)",
  background: "transparent",
  color: "var(--term-foreground)",
};

const hostNameStyle: Record<string, string> = {
  "font-weight": "bold",
  display: "flex",
  "align-items": "center",
  gap: "6px",
};

function authBadgeStyle(kind: "agent" | "password"): Record<string, string> {
  return {
    "font-size": "11px",
    color: kind === "password" ? "var(--pg-fg-dim)" : "var(--pg-accent)",
  };
}

const hostMetaStyle: Record<string, string> = {
  "font-size": "11px",
  color: "var(--pg-fg-dim)",
};

const actionsStyle: Record<string, string> = {
  display: "flex",
  "justify-content": "space-between",
  gap: "10px",
  "margin-top": "12px",
};

const primaryButtonStyle: Record<string, string> = {
  padding: "8px 16px",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  cursor: "pointer",
  "border-radius": "4px",
  border: "1px solid var(--pg-accent)",
  background: "var(--pg-accent)",
  color: "var(--term-background)",
};

const secondaryButtonStyle: Record<string, string> = {
  padding: "8px 14px",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  cursor: "pointer",
  "border-radius": "4px",
  border: "1px solid var(--pg-overlay-border)",
  background: "transparent",
  color: "var(--term-foreground)",
};
