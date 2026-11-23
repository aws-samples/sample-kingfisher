import { describe, it, expect } from "vitest";
import { dmsResourceNames, tableMappings, platformEndpointTaskShort, dmsTaskShortOf, describeEndpointConnections, latestConnectionVerdict, isSettledStop } from "../dms-service";

describe("dmsResourceNames", () => {
  it("derives stable DMS identifiers from a task id", () => {
    const n = dmsResourceNames("01KVTM4S3CYMKRMZ6TS39ZNX00");
    expect(n.srcId).toMatch(/^bgp-src-[a-z0-9]+$/);
    expect(n.tgtId).toMatch(/^bgp-tgt-[a-z0-9]+$/);
    expect(n.taskIdent).toMatch(/^bgp-rt-[a-z0-9]+$/);
    // 同一 taskId 稳定可复现(幂等查找依赖)
    expect(dmsResourceNames("01KVTM4S3CYMKRMZ6TS39ZNX00")).toEqual(n);
  });

  it("sanitizes to DMS-legal identifier chars (lowercase alnum + hyphen)", () => {
    const n = dmsResourceNames("Weird_ID!@#012345678");
    expect(n.srcId).toMatch(/^bgp-src-[a-z0-9]+$/);
  });
});

describe("tableMappings", () => {
  it("builds a valid selection rule for schema.table", () => {
    const m = JSON.parse(tableMappings("ecommerce", "realtime_demo"));
    expect(m.rules[0]["rule-type"]).toBe("selection");
    expect(m.rules[0]["object-locator"]).toEqual({ "schema-name": "ecommerce", "table-name": "realtime_demo" });
    expect(m.rules[0]["rule-action"]).toBe("include");
  });

  it("supports whole-schema wildcard", () => {
    const m = JSON.parse(tableMappings("ecommerce", "%"));
    expect(m.rules[0]["object-locator"]["table-name"]).toBe("%");
  });
});

describe("平台端点的标识(清扫靠它认「这是平台建的、属于哪条任务」)", () => {
  it("端点标识里的任务短名与 names() 同一份规则:源 / 目标两个端点、任务 id 三者对得上", () => {
    const taskId = "01KVTM4S3CYMKRMZ6TS39ZNX00";
    const n = dmsResourceNames(taskId);
    expect(platformEndpointTaskShort(n.srcId)).toBe(dmsTaskShortOf(taskId));
    expect(platformEndpointTaskShort(n.tgtId)).toBe(dmsTaskShortOf(taskId));
    expect(dmsTaskShortOf(taskId)).toBe("mz6ts39znx00");
  });
  it("不是平台形态的标识 ⇒ null(客户自己建的端点、复制任务的标识、带多余后缀的都不认)", () => {
    for (const id of ["my-endpoint", "bgp-rt-mz6ts39znx00", "bgp-src-", "bgp-src-MZ6TS39ZNX00", "bgp-src-mz6ts39znx00-copy", "xbgp-src-abc", "bgp-tgt-abcdefghijklm", ""]) {
      expect(platformEndpointTaskShort(id), id).toBeNull();
    }
  });
});

describe("describeEndpointConnections:连不上时把 DMS 给的失败原文带出来", () => {
  it("失败的那一端带原文(截到 200 字);没失败的只写状态", () => {
    expect(describeEndpointConnections({ source: "successful", target: "testing" })).toBe("源=successful 目标=testing");
    const long = "Test Endpoint failed: " + "x".repeat(400);
    const text = describeEndpointConnections({ source: "failed", target: "successful", sourceFailure: long });
    expect(text).toBe(`源=failed(${long.slice(0, 200)}) 目标=successful`);
  });
});

describe("latestConnectionVerdict:每一端最近一次出了结果的连通性结论", () => {
  const unknown = { source: "unknown", target: "unknown" };
  it("正在测 / 还没测不覆盖已经出了结果的结论:上一轮的失败(连同原文)留着", () => {
    const failed = latestConnectionVerdict(unknown, { source: "failed", target: "testing", sourceFailure: "Access denied" });
    expect(failed).toEqual({ source: "failed", target: "testing", sourceFailure: "Access denied" });
    // 下一轮:源端被重测刷回 testing,目标端出了结果
    expect(latestConnectionVerdict(failed, { source: "testing", target: "successful" }))
      .toEqual({ source: "failed", target: "successful", sourceFailure: "Access denied" });
  });
  it("新的结论覆盖旧的:成功会清掉之前的失败原文,新的失败换成新的原文", () => {
    const prev = { source: "failed", target: "failed", sourceFailure: "old source", targetFailure: "old target" };
    expect(latestConnectionVerdict(prev, { source: "successful", target: "failed", targetFailure: "new target" }))
      .toEqual({ source: "successful", target: "failed", targetFailure: "new target" });
  });
  it("一次结果都没出过 ⇒ 如实是当前的状态(不编结论)", () => {
    expect(latestConnectionVerdict(unknown, { source: "testing", target: "testing" })).toEqual({ source: "testing", target: "testing" });
  });
});

describe("isSettledStop:DMS 说的「已停止」作不作数(列表对账、详情状态与「停止」共用的唯一判定)", () => {
  // 取值照 2026-11-23 真环境每秒只读轮询的一轮:首次启动 03:03:31 → 被停 → 03:05:19 起报 stopped(无停止原因)→ 03:05:52 弹回 running
  //   → 03:06:21 stopped + Stop Reason NORMAL + 停止时刻 03:05:06;再启动 03:08:11(停止原因清空)→ 再停 → 停止时刻 03:10:47
  const at = (hms: string) => Date.parse(`2026-11-23T${hms}Z`);
  const st = (o: Partial<Parameters<typeof isSettledStop>[0]>) => ({ status: "stopped", startedAt: null, stoppedAt: null, ...o });

  it("没有停止原因 ⇒ 不作数(刚被停 / 刚启动的头几十秒 DMS 会这样报,随后可能弹回运行中)", () => {
    expect(isSettledStop(st({ startedAt: at("03:03:31") }))).toBe(false);
    expect(isSettledStop(st({ stopReason: "", startedAt: at("03:08:11"), stoppedAt: at("03:05:06") }))).toBe(false);
    expect(isSettledStop(st({ startedAt: at("03:03:31"), stoppedAt: at("03:05:06") }))).toBe(false);
  });

  it("带停止原因、停止时刻不早于最近一次启动 ⇒ 停稳", () => {
    expect(isSettledStop(st({ stopReason: "Stop Reason NORMAL", startedAt: at("03:03:31"), stoppedAt: at("03:05:06") }))).toBe(true);
    expect(isSettledStop(st({ stopReason: "Stop Reason NORMAL", startedAt: at("03:08:11"), stoppedAt: at("03:10:47") }))).toBe(true);
    expect(isSettledStop(st({ stopReason: "Stop Reason FULL_LOAD_ONLY_FINISHED", startedAt: at("03:08:11"), stoppedAt: at("03:08:11") }))).toBe(true);
  });

  it("带着停止原因,但停止时刻早于最近一次启动 ⇒ 那是上一轮的停止,不作数", () => {
    expect(isSettledStop(st({ stopReason: "Stop Reason NORMAL", startedAt: at("03:08:11"), stoppedAt: at("03:05:06") }))).toBe(false);
  });

  it("时刻读不出(null)不等于「停在启动之前」:带停止原因就作数", () => {
    expect(isSettledStop(st({ stopReason: "Stop Reason NORMAL" }))).toBe(true);
    expect(isSettledStop(st({ stopReason: "Stop Reason NORMAL", startedAt: at("03:08:11") }))).toBe(true);
    expect(isSettledStop(st({ stopReason: "Stop Reason NORMAL", stoppedAt: at("03:05:06") }))).toBe(true);
  });

  it("出错停下(停止原因含 ERROR)不拿时刻去拦:失败要尽快如实报", () => {
    expect(isSettledStop(st({ stopReason: "Stop Reason FATAL_ERROR", startedAt: at("03:08:11"), stoppedAt: at("03:05:06") }))).toBe(true);
    expect(isSettledStop(st({ stopReason: "Stop Reason RECOVERABLE_ERROR" }))).toBe(true);
  });

  it("不是 stopped 的状态一律不是「停稳」", () => {
    for (const status of ["running", "starting", "stopping", "modifying", "ready", "failed", "deleting", ""]) {
      expect(isSettledStop(st({ status, stopReason: "Stop Reason NORMAL", startedAt: at("03:03:31"), stoppedAt: at("03:05:06") })), status).toBe(false);
    }
  });
});
