// 设置面板内容 —— 缩放 / 主题 / 远程主机(SSH profile CRUD)。挂在 `Modal` 里。
//
// 缩放滑块:label 实时跟手,但真正提交给 settings(触发 re-measure + resize +
// DOM grid 整屏更新)做 120ms trailing debounce,避免拖动时连环重排。
//
// 远程主机区是 Phase 5 SSH 的桌面 side-door(也是平板上 SSH 唯一入口)——
// 用户在这里增删改主机,**完全不接触文件系统**。后端 `~/.perga/hosts.toml`
// 是持久化实现细节,密码字段明文存盘 + 0600 文件权限 + 平板 sandbox 隔离
// (Phase 6 切到 `app_data_dir` 时自动跨平台)。

import {
  For,
  Show,
  type Component,
  createResource,
  createSignal,
} from "solid-js";

import { THEME_IDS, type ThemeId } from "../render/theme";
import {
  type HostProfileBody,
  type HostProfileSummary,
  ProfileApiError,
  createProfile,
  deleteProfile,
  fetchProfiles,
  updateProfile,
} from "../state/profiles";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "../state/settings";
import { useSettings } from "../state/settings_context";
import { HostForm, emptyProfile, profileToBody } from "./host_form";

const THEME_LABELS: Record<ThemeId, string> = {
  dark: "深色",
  light: "浅色",
};

const ZOOM_COMMIT_DELAY = 120;

export type SettingsPanelProps = {
  /// 点 "Connect" 按钮时调,父层负责开新 tab + 关 modal。
  /// 不传 = 远程主机区域不显示 Connect 按钮(测试 / 早期 Tauri 路径)。
  onConnectProfile?: (profileId: string) => void;
};

/// 用于 inline 编辑 / 添加的 "正在编辑" 状态。
/// - `null` = 没在编辑
/// - `{ kind: "new" }` = 显示空表单准备创建
/// - `{ kind: "edit", id }` = 显示填充表单编辑已有 profile
type EditState =
  | null
  | { kind: "new" }
  | { kind: "edit"; id: string };

export const SettingsPanel: Component<SettingsPanelProps> = (props) => {
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

  // 远程主机列表 ── createResource 给个 refetch 钩子,CRUD 操作完调一下。
  // `result()` 是 discriminated union(ok / error),UI 据此分两路渲染:
  // 空 ok = 没配主机的提示,error = 加载失败的红框(掩盖 toml parse 错就是
  // 它要修的)。
  const [profilesResult, { refetch: refetchProfiles }] =
    createResource(fetchProfiles);
  const profileList = (): HostProfileSummary[] => {
    const r = profilesResult();
    return r?.kind === "ok" ? r.profiles : [];
  };
  const loadError = (): string | null => {
    const r = profilesResult();
    return r?.kind === "error" ? r.message : null;
  };
  const [edit, setEdit] = createSignal<EditState>(null);
  const [opError, setOpError] = createSignal<string | null>(null);

  const closeEdit = (): void => {
    setEdit(null);
    setOpError(null);
  };

  const onSubmit = async (body: HostProfileBody): Promise<void> => {
    setOpError(null);
    try {
      const state = edit();
      if (state?.kind === "new") {
        await createProfile(body);
      } else if (state?.kind === "edit") {
        await updateProfile(state.id, body);
      }
      closeEdit();
      await refetchProfiles();
    } catch (e) {
      const msg =
        e instanceof ProfileApiError
          ? `${e.message} (HTTP ${e.status})`
          : String(e);
      setOpError(msg);
    }
  };

  const onDelete = async (id: string, name: string): Promise<void> => {
    if (!confirm(`删除主机「${name}」?\n(本地 hosts.toml 也会更新)`)) return;
    setOpError(null);
    try {
      await deleteProfile(id);
      await refetchProfiles();
    } catch (e) {
      const msg =
        e instanceof ProfileApiError
          ? `${e.message} (HTTP ${e.status})`
          : String(e);
      setOpError(msg);
    }
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

      <section style={sectionStyle}>
        <div style={labelRowStyle}>
          <span>远程主机</span>
          <button
            type="button"
            style={addButtonStyle}
            disabled={edit() !== null}
            onClick={() => {
              setOpError(null);
              setEdit({ kind: "new" });
            }}
          >
            + 添加主机
          </button>
        </div>

        <Show when={loadError()}>
          <div style={errorStyle}>
            <div style={{ "font-weight": "bold", "margin-bottom": "4px" }}>
              加载主机列表失败
            </div>
            <div style={{ "font-size": "11px", "white-space": "pre-wrap" }}>
              {loadError()}
            </div>
            <div
              style={{
                "font-size": "11px",
                "margin-top": "6px",
                color: "var(--pg-fg-dim)",
              }}
            >
              通常是 ~/.perga/hosts.toml 解析错;修好后重开设置即可。
            </div>
          </div>
        </Show>

        <Show when={opError()}>
          <div style={errorStyle}>{opError()}</div>
        </Show>

        <Show when={edit()?.kind === "new"}>
          <HostForm
            initial={emptyProfile()}
            onSubmit={onSubmit}
            onCancel={closeEdit}
          />
        </Show>

        <Show
          when={
            profileList().length > 0 ||
            edit()?.kind === "new" ||
            loadError() !== null
          }
          fallback={<div style={hintStyle}>{EMPTY_HOSTS_HINT}</div>}
        >
          <div style={hostsListStyle}>
            <For each={profileList()}>
              {(p) => {
                const editingThis = (): boolean => {
                  const e = edit();
                  return e?.kind === "edit" && e.id === p.id;
                };
                return (
                  <Show
                    when={editingThis()}
                    fallback={
                      <HostRow
                        profile={p}
                        editing={edit() !== null}
                        onEdit={() => {
                          setOpError(null);
                          setEdit({ kind: "edit", id: p.id });
                        }}
                        onDelete={() => onDelete(p.id, p.name)}
                        onConnect={props.onConnectProfile}
                      />
                    }
                  >
                    <HostForm
                      initial={profileToBody(p)}
                      onSubmit={onSubmit}
                      onCancel={closeEdit}
                    />
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
};

const EMPTY_HOSTS_HINT = "还没有主机。点「+ 添加主机」开始配置。";

const HostRow: Component<{
  profile: HostProfileSummary;
  editing: boolean; // 任何一行正在编辑时,其他行的按钮禁用
  onEdit: () => void;
  onDelete: () => void;
  onConnect?: (id: string) => void;
}> = (props) => (
  <div style={hostRowStyle}>
    <div style={{ "min-width": "0", flex: "1" }}>
      <div style={hostNameStyle}>
        {props.profile.name}
        <span style={authBadgeStyle(props.profile.auth_kind)}>
          {props.profile.auth_kind === "password" ? "🔒" : "🔑"}
        </span>
      </div>
      <div style={hostMetaStyle}>
        {`${props.profile.user}@${props.profile.host}:${props.profile.port}`}
      </div>
    </div>
    <div style={{ display: "flex", gap: "6px" }}>
      <button
        type="button"
        style={secondaryButtonStyle}
        disabled={props.editing}
        onClick={props.onEdit}
      >
        编辑
      </button>
      <button
        type="button"
        style={dangerButtonStyle}
        disabled={props.editing}
        onClick={props.onDelete}
      >
        删除
      </button>
      <Show when={props.onConnect}>
        <button
          type="button"
          style={connectButtonStyle}
          disabled={props.editing}
          onClick={() => props.onConnect?.(props.profile.id)}
        >
          Connect
        </button>
      </Show>
    </div>
  </div>
);

// HostForm / FormField / slugify / emptyProfile / profileToBody 抽到了
// `host_form.tsx`,以便 profile_picker.tsx 复用同一个表单。

// ─────────────────── styles ───────────────────

const rootStyle: Record<string, string> = {
  padding: "18px 20px",
  "min-width": "380px",
  "max-width": "520px",
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
  "align-items": "center",
  "margin-bottom": "8px",
};

const hintStyle: Record<string, string> = {
  color: "var(--pg-fg-dim)",
  "font-size": "11px",
  "margin-top": "4px",
};

const errorStyle: Record<string, string> = {
  color: "#ff6b6b",
  "font-size": "12px",
  "margin-bottom": "8px",
  padding: "6px 10px",
  "border-radius": "4px",
  border: "1px solid #ff6b6b",
  background: "rgba(255,107,107,0.08)",
};

const hostsListStyle: Record<string, string> = {
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
};

const hostRowStyle: Record<string, string> = {
  display: "flex",
  "align-items": "center",
  gap: "10px",
  padding: "8px 10px",
  "border-radius": "5px",
  border: "1px solid var(--pg-overlay-border)",
  background: "transparent",
};

const hostNameStyle: Record<string, string> = {
  "font-family": "ui-monospace, monospace",
  "font-size": "13px",
  color: "var(--term-foreground)",
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
  "font-family": "ui-monospace, monospace",
  "font-size": "11px",
  color: "var(--pg-fg-dim)",
  "margin-top": "2px",
};

// formStyle / formFieldStyle / formLabelStyle / inputStyle / formHintStyle /
// formActionsStyle / primaryButtonStyle 一并搬到 `host_form.tsx`,这里只保留
// 设置面板自己用到的 chrome 样式(host row / 按钮等)。

const secondaryButtonStyle: Record<string, string> = {
  padding: "6px 12px",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  cursor: "pointer",
  "border-radius": "4px",
  border: "1px solid var(--pg-overlay-border)",
  background: "transparent",
  color: "var(--term-foreground)",
};

const dangerButtonStyle: Record<string, string> = {
  padding: "6px 10px",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  cursor: "pointer",
  "border-radius": "4px",
  border: "1px solid #ff6b6b",
  background: "transparent",
  color: "#ff6b6b",
};

const connectButtonStyle: Record<string, string> = {
  padding: "6px 12px",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  cursor: "pointer",
  "border-radius": "4px",
  border: "1px solid var(--pg-accent)",
  background: "transparent",
  color: "var(--pg-accent)",
};

const addButtonStyle: Record<string, string> = {
  padding: "4px 10px",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  cursor: "pointer",
  "border-radius": "4px",
  border: "1px solid var(--pg-accent)",
  background: "transparent",
  color: "var(--pg-accent)",
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
