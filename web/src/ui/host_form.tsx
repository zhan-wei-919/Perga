// 可复用 host profile 表单。两处复用:
// - `settings_panel.tsx` 的远程主机区(inline 新增 / 编辑)
// - `profile_picker.tsx` 的「第一次启动加 host」引导卡
//
// 表单本地状态各字段独立 signal,简单直接;父层通过 `onSubmit` 拿到完整 body,
// 自己决定调 `createProfile` / `updateProfile`。
//
// 「密码留空 = 走 agent」是 v1 桌面便利策略;平板留空 = 走 agent 但 agent 不
// 可用 → 实际连接时 ssh crate 报错,前端 SessionError banner 显示。

import {
  type Component,
  type JSX,
  createSignal,
} from "solid-js";

import type { HostProfileBody, HostProfileSummary } from "../state/profiles";

export type HostFormProps = {
  initial: HostProfileBody;
  onSubmit: (body: HostProfileBody) => void;
  onCancel: () => void;
  /** 提交按钮文字。"保存" 默认;picker 引导可改成 "添加并连接"。 */
  submitLabel?: string;
};

export const HostForm: Component<HostFormProps> = (props) => {
  const initial = props.initial;
  const [name, setName] = createSignal(initial.name);
  const [user, setUser] = createSignal(initial.user);
  const [host, setHost] = createSignal(initial.host);
  const [port, setPort] = createSignal(initial.port);
  const initialPassword =
    initial.auth.type === "password" ? initial.auth.password : "";
  const [password, setPassword] = createSignal(initialPassword);

  // 编辑模式下 id 不可改;新建模式自动生成(用 name 派生 + 时间戳 fallback)。
  const isNew = initial.id === "";

  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    const trimmedPwd = password();
    const auth: HostProfileBody["auth"] =
      trimmedPwd.length > 0
        ? { type: "password", password: trimmedPwd }
        : { type: "agent" };
    const id = isNew ? slugify(name()) || `host-${Date.now()}` : initial.id;
    props.onSubmit({
      id,
      name: name(),
      user: user(),
      host: host(),
      port: port(),
      auth,
    });
  };

  return (
    <form style={formStyle} onSubmit={submit}>
      <FormField label="名称">
        <input
          type="text"
          required
          autofocus
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          style={inputStyle}
          placeholder="给这台机器起个名"
        />
      </FormField>
      <FormField label="用户名">
        <input
          type="text"
          required
          value={user()}
          onInput={(e) => setUser(e.currentTarget.value)}
          style={inputStyle}
          placeholder="root / ubuntu / ..."
        />
      </FormField>
      <FormField label="主机 / IP">
        <input
          type="text"
          required
          value={host()}
          onInput={(e) => setHost(e.currentTarget.value)}
          style={inputStyle}
          placeholder="example.com 或 192.168.1.10"
        />
      </FormField>
      <FormField label="端口">
        <input
          type="number"
          required
          min={1}
          max={65535}
          value={port()}
          onInput={(e) => setPort(Number(e.currentTarget.value) || 22)}
          style={{ ...inputStyle, width: "100px" }}
        />
      </FormField>
      <FormField label="密码">
        <input
          type="password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          style={inputStyle}
          placeholder="留空使用 ssh-agent(桌面)"
        />
      </FormField>
      <div style={formHintStyle}>
        密码存于本机 Perga 数据目录,文件权限 0600(仅当前用户可读)。
      </div>
      <div style={formActionsStyle}>
        <button type="button" style={secondaryButtonStyle} onClick={props.onCancel}>
          取消
        </button>
        <button type="submit" style={primaryButtonStyle}>
          {props.submitLabel ?? "保存"}
        </button>
      </div>
    </form>
  );
};

const FormField: Component<{
  label: string;
  children: JSX.Element;
}> = (props) => (
  <label style={formFieldStyle}>
    <span style={formLabelStyle}>{props.label}</span>
    {props.children}
  </label>
);

/// 拿 name 派生一个合法 id(小写英数 + 连字符)。空 / 全字符不可用时调用方
/// fallback 到 `host-<timestamp>`。
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function emptyProfile(): HostProfileBody {
  return {
    id: "",
    name: "",
    user: "",
    host: "",
    port: 22,
    auth: { type: "agent" },
  };
}

/// `HostProfileSummary` → `HostProfileBody` 转换。密码字段空白(GET 路径不返
/// 密码),用户不重新填就保持 agent;重新填就用新密码生效。
export function profileToBody(p: HostProfileSummary): HostProfileBody {
  return {
    id: p.id,
    name: p.name,
    user: p.user,
    host: p.host,
    port: p.port,
    auth: { type: "agent" },
  };
}

// ─────────────────── styles ───────────────────

const formStyle: Record<string, string> = {
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  padding: "12px",
  "border-radius": "6px",
  border: "1px solid var(--pg-accent)",
  background: "var(--pg-overlay-hover)",
  "margin-bottom": "8px",
};

const formFieldStyle: Record<string, string> = {
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
};

const formLabelStyle: Record<string, string> = {
  "font-size": "11px",
  color: "var(--pg-fg-dim)",
  "text-transform": "uppercase",
  "letter-spacing": "0.04em",
};

const inputStyle: Record<string, string> = {
  padding: "6px 8px",
  "font-family": "ui-monospace, monospace",
  "font-size": "13px",
  "border-radius": "4px",
  border: "1px solid var(--pg-overlay-border)",
  background: "var(--term-background)",
  color: "var(--term-foreground)",
};

const formHintStyle: Record<string, string> = {
  color: "var(--pg-fg-dim)",
  "font-size": "11px",
  "margin-top": "0",
};

const formActionsStyle: Record<string, string> = {
  display: "flex",
  "justify-content": "flex-end",
  gap: "8px",
  "margin-top": "4px",
};

const primaryButtonStyle: Record<string, string> = {
  padding: "6px 14px",
  "font-family": "ui-monospace, monospace",
  "font-size": "12px",
  cursor: "pointer",
  "border-radius": "4px",
  border: "1px solid var(--pg-accent)",
  background: "var(--pg-accent)",
  color: "var(--term-background)",
};

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
