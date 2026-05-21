// autotest 单测:纯统计 helper + run() 主循环。
// run() 的命令阶段已由 command_block 事件驱动 —— 用合成事件流即可确定性地测。

import { describe, expect, it } from "vitest";

import type { ClientMessage } from "../src/state/wire";
import { AutoBench, percentile, summarize } from "../src/util/autotest";

describe("summarize", () => {
  it("空样本返回全 0", () => {
    expect(summarize([])).toEqual({
      min: 0,
      p50: 0,
      p90: 0,
      p99: 0,
      max: 0,
      mean: 0,
    });
  });

  it("算出 min/max/mean 与分位数", () => {
    const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBe(5.5);
    // i = floor((n-1)*q):p50 → floor(9*0.5)=4 → sorted[4]=5
    expect(s.p50).toBe(5);
    expect(s.p90).toBe(9);
    expect(s.p99).toBe(9);
  });

  it("不修改入参(内部拷贝后排序)", () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("percentile", () => {
  it("空数组返回 0", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("单元素任意分位都返回该元素", () => {
    expect(percentile([42], 0.99)).toBe(42);
  });
});

describe("AutoBench.run", () => {
  it("returns null when no socket is attached", async () => {
    const bench = new AutoBench();
    expect(await bench.run("ls", 1)).toBeNull();
  });

  it("resolves each command on its command_block event", async () => {
    const bench = new AutoBench();
    const sent: ClientMessage[] = [];
    bench.attach(
      (msg) => {
        sent.push(msg);
        // 模拟后端:收到回车后,命令跑完回一条 command_block。
        if (msg.type === "key" && msg.key.type === "enter") {
          setTimeout(() => {
            bench.onEvent(0.1);
            bench.onCommandBlock();
          }, 5);
        }
      },
      () => false,
    );

    const result = await bench.run("ls", 3);
    expect(result).not.toBeNull();
    expect(result?.completed).toBe(3);
    expect(result?.timeouts).toBe(0);
    expect(result?.iterations).toBe(3);
    // 每条命令:'l'、's' 两个 char key + 一个 enter key。
    const enters = sent.filter(
      (m) => m.type === "key" && m.key.type === "enter",
    );
    expect(enters).toHaveLength(3);
  });

  it("stops early when abort signals", async () => {
    const bench = new AutoBench();
    bench.attach(
      () => {},
      () => true,
    );
    const result = await bench.run("ls", 5);
    expect(result?.completed).toBe(0);
  });
});
