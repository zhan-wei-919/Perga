// autotest 的纯统计 helper 单测。静默检测状态机依赖真实计时器,不在此覆盖。

import { describe, expect, it } from "vitest";

import { percentile, summarize } from "../src/util/autotest";

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
