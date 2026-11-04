// @kf-batch 42-ux-feedback —— /sync 自动刷新的事实:非终态清单闭合、间隔 8s、判定按字符串状态。
import { describe, it, expect } from "vitest";
import { SYNC_AUTO_REFRESH_MS, SYNC_IN_FLIGHT_STATUSES, anySyncInFlight } from "../auto-refresh";

describe("自动刷新事实", () => {
  it("非终态清单 = running / starting / stopping;间隔 8000ms", () => {
    expect([...SYNC_IN_FLIGHT_STATUSES]).toEqual(["running", "starting", "stopping"]);
    expect(SYNC_AUTO_REFRESH_MS).toBe(8000);
  });
  it("有一条在跑就要刷;全终态 / 空列表 / 未知状态都不刷", () => {
    expect(anySyncInFlight([{ status: "succeeded" }, { status: "running" }])).toBe(true);
    expect(anySyncInFlight([{ status: "starting" }])).toBe(true);
    expect(anySyncInFlight([{ status: "stopping" }])).toBe(true);
    expect(anySyncInFlight([{ status: "succeeded" }, { status: "stopped" }, { status: "error" }, { status: "draft" }])).toBe(false);
    expect(anySyncInFlight([])).toBe(false);
    expect(anySyncInFlight([{ status: undefined }, { status: "RUNNING" }, { status: 1 }])).toBe(false);
  });
});
