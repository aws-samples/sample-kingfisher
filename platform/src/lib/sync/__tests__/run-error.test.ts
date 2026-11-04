// 运行失败原话分类(唯一作者 lib/sync/run-error.ts)的判据:闭合清单、对象 id 提取、认不出原样保留、读侧呈现规则。
//
// 【缺陷原形】2026-10-28 测试账号:平台安全组被平台外删除后,运行历史里每条失败只有 AWS 原话
//   「… Security Group Not Found The security group 'sg-07f9a7c9ddd9cb680' does not exist …」,用户不知道是什么、下一步点哪里。
import { describe, it, expect } from "vitest";
import { classifyRunError, isNetworkDrift, presentRunRow } from "@/lib/sync/run-error";

const SG_RAW = "Glue ETL Marketplace - failed to execute with exception Security Group Not Found The security group 'sg-07f9a7c9ddd9cb680' does not exist (Service: AWSGlueJobExecutor; Status Code: 400; Error Code: InvalidInputException)";

describe("classifyRunError:闭合清单 + 对象 id", () => {
  it("安全组不存在 ⇒ network-drift-security-group,点名 sg id,中文结论指到「编辑 → 网络配置」,原话另存", () => {
    const c = classifyRunError(SG_RAW);
    expect(c.kind).toBe("network-drift-security-group");
    expect(c.objectId).toBe("sg-07f9a7c9ddd9cb680");
    expect(c.message).toContain("sg-07f9a7c9ddd9cb680");
    expect(c.message).toContain("被平台外删除");
    expect(c.message).toContain("网络配置");
    expect(c.raw).toBe(SG_RAW);
  });
  it("InvalidGroup.NotFound 同类;子网 / 连接各自一类并点名对象", () => {
    expect(classifyRunError("An error occurred (InvalidGroup.NotFound) when calling …").kind).toBe("network-drift-security-group");
    const sub = classifyRunError("The subnet 'subnet-0abc12345678def90' does not exist");
    expect(sub.kind).toBe("network-drift-subnet");
    expect(sub.objectId).toBe("subnet-0abc12345678def90");
    const conn = classifyRunError("EntityNotFoundException: Connection bgp-conn-AAAADS0133 not found");
    expect(conn.kind).toBe("glue-connection-missing");
    expect(conn.objectId).toBe("bgp-conn-AAAADS0133");
  });
  it("并发上限 / 目标表守卫各自一类;认不出的原样保留为 unknown(不编造结论)", () => {
    expect(classifyRunError("ConcurrentRunsExceededException: Concurrent runs exceeded for bgp-sync-x").kind).toBe("concurrent-runs");
    expect(classifyRunError("SYNC_REFUSED_CLEAR_FOREIGN_TABLE ods.players").kind).toBe("foreign-table-guard");
    const u = classifyRunError("java.lang.OutOfMemoryError: GC overhead limit exceeded");
    expect(u.kind).toBe("unknown");
    expect(u.message).toBe("java.lang.OutOfMemoryError: GC overhead limit exceeded");
  });
  it("空 / null / undefined ⇒ unknown,raw 为 null", () => {
    expect(classifyRunError(null)).toEqual({ kind: "unknown", message: "", raw: null });
    expect(classifyRunError(undefined)).toEqual({ kind: "unknown", message: "", raw: null });
    expect(classifyRunError("   ")).toEqual({ kind: "unknown", message: "   ", raw: "   " });
  });
  it("isNetworkDrift 只认三种漂移类", () => {
    expect(isNetworkDrift("network-drift-security-group")).toBe(true);
    expect(isNetworkDrift("network-drift-subnet")).toBe(true);
    expect(isNetworkDrift("glue-connection-missing")).toBe(true);
    expect(isNetworkDrift("concurrent-runs")).toBe(false);
    expect(isNetworkDrift("datasource-network-broken")).toBe(false);
    expect(isNetworkDrift("unknown")).toBe(false);
  });
});

describe("presentRunRow:读侧只翻存量 / 调度运行时写的行", () => {
  it("没有 errorRaw 的失败行 ⇒ error 换中文、补 errorRaw / errorKind;其余字段原样", () => {
    const row = { runId: "r1", status: "failed", error: SG_RAW, metrics: { rowsRead: 0 } };
    const out = presentRunRow(row) as typeof row & { errorRaw?: string; errorKind?: string };
    expect(out.errorRaw).toBe(SG_RAW);
    expect(out.errorKind).toBe("network-drift-security-group");
    expect(out.error).toContain("sg-07f9a7c9ddd9cb680");
    expect(out.error).not.toBe(SG_RAW);
    expect(out.metrics).toEqual({ rowsRead: 0 });
    expect(row.error).toBe(SG_RAW); // 不改入参
  });
  it("已有 errorRaw 的行(写侧分类过)原样返回;认不出的 / 无 error / error 非串的原样返回", () => {
    const done = { error: "已翻好", errorRaw: SG_RAW };
    expect(presentRunRow(done)).toBe(done);
    const unknown = { error: "boom" };
    expect(presentRunRow(unknown)).toBe(unknown);
    const ok = { status: "succeeded", error: null };
    expect(presentRunRow(ok)).toBe(ok);
    const weird = { error: 42 };
    expect(presentRunRow(weird)).toBe(weird);
  });
});
