// `?perf=1` 时显示的自动化基准触发器。点一下连续跑 N 条命令,详细汇总打印到
// console,UI 上只显示进度和上一轮的 p99 速览。
//
// 单独成块、不并进 perf overlay:overlay 自身 `pointer-events: none`,放不了
// 可点击元素。位置叠在 overlay 下方。

import { Component, Show, createSignal } from "solid-js";

import type { AutoBench } from "../util/autotest";

const DEFAULT_COMMAND = "ls";
const DEFAULT_ITERATIONS = 100;

/// 自动基准面板:命令输入 + 次数输入 + run 按钮。
export const AutoTestButton: Component<{ bench: AutoBench }> = (props) => {
  const [command, setCommand] = createSignal(DEFAULT_COMMAND);
  const [iterations, setIterations] = createSignal(DEFAULT_ITERATIONS);
  const [running, setRunning] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [summary, setSummary] = createSignal<string | null>(null);

  const start = async (): Promise<void> => {
    const cmd = command().trim();
    if (!cmd || running()) return;
    setRunning(true);
    setSummary(null);
    setProgress(0);

    const result = await props.bench.run(cmd, iterations(), (done, total) => {
      setProgress(done / total);
    });

    setRunning(false);
    if (result) {
      setSummary(
        `latency p99 ${result.latency.p99.toFixed(1)}ms · ` +
          `dispatch p99 ${result.dispatchP99.toFixed(1)}ms · 详见 console`,
      );
    }
  };

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", gap: "4px" }}>
        <input
          style={inputStyle}
          value={command()}
          disabled={running()}
          onInput={(e) => setCommand(e.currentTarget.value)}
        />
        <input
          style={{ ...inputStyle, width: "42px" }}
          type="number"
          min="1"
          value={iterations()}
          disabled={running()}
          onInput={(e) =>
            setIterations(Math.max(1, Number(e.currentTarget.value) || 1))
          }
        />
        <button style={buttonStyle} disabled={running()} onClick={start}>
          {running() ? `${Math.round(progress() * 100)}%` : "run bench"}
        </button>
      </div>
      <Show when={summary()}>
        <div style={summaryStyle}>{summary()}</div>
      </Show>
    </div>
  );
};

const panelStyle: Record<string, string> = {
  position: "fixed",
  // overlay 约 70px 高,叠在它下面。
  top: "84px",
  right: "6px",
  "font-family": "ui-monospace, monospace",
  "font-size": "11px",
  color: "#9cdcfe",
  background: "rgba(0, 0, 0, 0.65)",
  padding: "6px 8px",
  "border-radius": "4px",
  "z-index": "9999",
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
};

const inputStyle: Record<string, string> = {
  width: "110px",
  "font-family": "ui-monospace, monospace",
  "font-size": "11px",
  color: "#d4d4d4",
  background: "#2a2a2a",
  border: "1px solid #444",
  "border-radius": "3px",
  padding: "2px 4px",
};

const buttonStyle: Record<string, string> = {
  "font-family": "ui-monospace, monospace",
  "font-size": "11px",
  color: "#1e1e1e",
  background: "#9cdcfe",
  border: "none",
  "border-radius": "3px",
  padding: "2px 8px",
  cursor: "pointer",
};

const summaryStyle: Record<string, string> = {
  color: "#b5cea8",
  "white-space": "nowrap",
};
