// 序 49 ③ B-95 → 序 50 第二批 —— 删项目空间的数据面盘点撞数仓冷启动(纯逻辑判据 + 调用点判据)。
//
// 【缺陷原形(…4216 production 全新账号,2026-10-18)】盘点 `proj_<id>` 表数预算 20×500ms = 10s;Redshift Serverless 闲置后
//   恢复常超 10s ⇒ 盘点记成「无法核实」⇒ fail-closed 400「…数仓不可达或无凭证…请稍后重试」;约 1 分钟后原样再发 200。
// 【序 49 的修法】第三态 pending + 路由 202 `{ status:"warming", retryAfterMs }` + 页面自动重发 —— 一套删项目专用的 202 协议。
// 【序 50 第二批】那套协议退役(B-111 同病同治,55 DESIGN §2.6a):删项目改成长操作 project-delete,盘点语句在执行体里经**唯一原语**
//   awaitTerminal 等到终态(最多 150 轮,500ms 起 ×1.5 顶 2s ≈ 296s,< 300s 天花板),数仓冷恢复超 45s 时整条删除由 submitLongOp 转 202
//   `protocol:"long-op/1"`,页面右下「正在后台执行:删除项目空间」;SchemaCheck 回到两态 ok / unavailable(fail-closed 不变)。
// 真环境那一半(页面一次点击最终删掉)由页面驱动段盯;这里钉等待逻辑、阻断算法与调用点。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { awaitSchemaCountStatement, buildBlockers, SCHEMA_COUNT_MAX_POLLS } from "@/lib/projects/project-resources";
import * as constants from "@/lib/projects/constants";
import { runInLongOp, LongOpContextMissing } from "@/lib/long-ops/context";
import { CEILING_MS } from "@/lib/long-ops/store";
import { EN } from "@/lib/i18n/messages/en";

class DescribeCmd { constructor(public input: { Id: string }) {} }
class ResultCmd { constructor(public input: { Id: string }) {} }
const CMDS = { DescribeStatementCommand: DescribeCmd, GetStatementResultCommand: ResultCmd };

/** 假 Redshift Data:DescribeStatement 按脚本逐次回状态(超出脚本长度重复最后一个);GetStatementResult 回给定值。 */
function fakeRs(statuses: string[], value?: string) {
  let idx = 0;
  const seen: string[] = [];
  let resultCalls = 0;
  return {
    seen,
    get resultCalls() { return resultCalls; },
    send: async (cmd: unknown) => {
      if (cmd instanceof DescribeCmd) {
        const status = statuses[Math.min(idx, statuses.length - 1)];
        idx += 1;
        seen.push(status);
        return { Id: cmd.input.Id, Status: status };
      }
      if (cmd instanceof ResultCmd) {
        resultCalls += 1;
        return { Records: [[value === undefined ? {} : { stringValue: value }]] };
      }
      throw new Error("意料外的命令");
    },
  };
}
/** 虚拟时钟:sleep 只推进时间,不真等。 */
function virtualClock() {
  let nowMs = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    sleep: async (ms: number) => { sleeps.push(ms); nowMs += ms; },
  };
}
/** 与执行体 project-delete 同一种等待上下文(判据直接调盘点函数时用它包一层)。 */
const inOp = <T,>(fn: () => Promise<T>) => runInLongOp({ taskId: "t-b95-judge", opKind: "project-delete" }, fn);

describe("🔴 B-95 awaitSchemaCountStatement:两态 + 预算 + 退避(经唯一原语 awaitTerminal)", () => {
  it("🔴 模块 55 闸门 ②:请求路径裸调(无长操作上下文)⇒ 抛 LongOpContextMissing,DescribeStatement 一次都不发", async () => {
    const rs = fakeRs(["STARTED", "FINISHED"], "7");
    await expect(awaitSchemaCountStatement(rs, CMDS, "st-0", { ...virtualClock() })).rejects.toBeInstanceOf(LongOpContextMissing);
    expect(rs.seen).toEqual([]);
  });

  it("STARTED 三次后 FINISHED ⇒ ok 拿到表数(不是把「等了一会」记成失败)", async () => {
    const rs = fakeRs(["PICKED", "STARTED", "STARTED", "FINISHED"], "7");
    const clock = virtualClock();
    const out = await inOp(() => awaitSchemaCountStatement(rs, CMDS, "st-1", { ...clock }));
    expect(out).toMatchObject({ tables: 7, check: "ok", statementStatus: "FINISHED" });
    expect(rs.seen).toEqual(["PICKED", "STARTED", "STARTED", "FINISHED"]);
    expect(out.waitedMs).toBe(clock.sleeps.reduce((a, b) => a + b, 0));
    // 退避形状:每次探测前先等(500ms 起、×1.5,取整)
    expect(clock.sleeps).toEqual([500, 750, 1125, 1688]);
  });

  it("🔴 缺陷原形:语句一直 STARTED(数仓恢复中)⇒ 等满 150 轮才回 unavailable(fail-closed;不再有 pending),期间由统一框架转 202 而不是在这里 45s 放弃", async () => {
    const rs = fakeRs(["STARTED"]);
    const clock = virtualClock();
    const out = await inOp(() => awaitSchemaCountStatement(rs, CMDS, "st-2", { ...clock }));
    expect(out).toMatchObject({ tables: null, check: "unavailable", statementStatus: "STARTED" });
    expect((out as { check: string }).check, "第三态 pending 已退役").not.toBe("pending");
    expect(rs.resultCalls).toBe(0);
    expect(rs.seen.length).toBe(SCHEMA_COUNT_MAX_POLLS);
    // 退避:500ms 起、×1.5、顶 2s ⇒ 整段等待 ≈ 296s:≥ 60s 覆盖冷启动(旧 45s 预算正是不够用的那个数),且 < 300s 长操作天花板(否则驱动器先 abort 成 timeout)
    expect(Math.max(...clock.sleeps)).toBe(2000);
    expect(clock.sleeps.slice(0, 4)).toEqual([500, 750, 1125, 1688]);
    expect(out.waitedMs).toBeGreaterThanOrEqual(60_000);
    expect(out.waitedMs).toBeLessThan(CEILING_MS);
  });

  it("FAILED ⇒ unavailable(fail-closed 语义不变),不去取结果", async () => {
    const rs = fakeRs(["STARTED", "FAILED"]);
    const out = await inOp(() => awaitSchemaCountStatement(rs, CMDS, "st-3", { ...virtualClock() }));
    expect(out).toMatchObject({ tables: null, check: "unavailable", statementStatus: "FAILED" });
    expect(rs.resultCalls).toBe(0);
  });

  it("ABORTED ⇒ unavailable;FINISHED 但结果不是数 ⇒ unavailable(绝不当 0)", async () => {
    const aborted = await inOp(() => awaitSchemaCountStatement(fakeRs(["ABORTED"]), CMDS, "st-4", { ...virtualClock() }));
    expect(aborted.check).toBe("unavailable");
    const nan = await inOp(() => awaitSchemaCountStatement(fakeRs(["FINISHED"]), CMDS, "st-5", { ...virtualClock() }));
    expect(nan).toMatchObject({ tables: null, check: "unavailable" });
  });

  it("预算常量:150 轮(≈ 296s)在 300s 天花板之内;删项目专用的 PROJECT_DELETE_WARMING 协议常量已删", () => {
    expect(SCHEMA_COUNT_MAX_POLLS).toBe(150);
    expect((constants as Record<string, unknown>).PROJECT_DELETE_WARMING).toBeUndefined();
    expect(CEILING_MS).toBe(300_000);
  });
});

describe("🔴 B-95 buildBlockers:两态 —— ok 不阻断,unavailable 仍阻断(fail-closed)", () => {
  const base = { counted: [], otherMembers: 0, schemaName: "proj_abc" };
  it("ok 且 0 张表 ⇒ 零阻断", () => {
    expect(buildBlockers({ ...base, schema: { tables: 0, check: "ok" } })).toEqual([]);
  });
  it("控制面有资源 ⇒ 只列资源", () => {
    const blockers = buildBlockers({ ...base, counted: [{ kind: "sync", label: "同步任务", count: 2 }], schema: { tables: 0, check: "ok" } });
    expect(blockers).toEqual(["同步任务 2 个"]);
  });
  it("unavailable ⇒ 阻断文案不变(fail-closed);「数仓正在唤醒」这种第三态文案一个字不许再出现", () => {
    const blockers = buildBlockers({ ...base, schema: { tables: null, check: "unavailable" } });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("无法核实数据面 schema proj_abc");
    expect(blockers[0]).not.toContain("唤醒");
  });
});

describe("🔴 B-95 调用点判据:路由只 submitLongOp · 执行体顺序 · 页面不再有专用 202 分支 · 文案词典", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("DELETE 路由:只留默认空间不可删 + D4 授权 + submitLongOp(kind project-delete);盘点 / 回收入队 / 删项目 / warming 协议一个都不留在路由", () => {
    const src = strip(read("app/api/projects/[id]/route.ts"));
    const fn = /export async function DELETE\(([\s\S]*?)\n\}/.exec(src)!;
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("DEFAULT_PROJECT_ID");
    expect(fn[1]).toContain("requireProjectConfigAdmin(");
    expect(fn[1]).toMatch(/submitLongOp\(/);
    expect(fn[1]).toContain('kind: "project-delete"');
    expect(fn[1]).toMatch(/longOpResponse\(req, result\)/);
    expect(fn[1]).toMatch(/longOpErrorResponse\(/);
    for (const gone of ["inventoryProject(", "enqueueProjectCredReclaim(", "deleteProject(", "PROJECT_DELETE_WARMING", '"warming"', "retryAfterMs", "正在唤醒数仓"]) {
      expect(src, `路由里不该再有 ${gone}`).not.toContain(gone);
    }
  });

  it("执行体 project-delete:盘点 → 阻断 400 → 回收入队(503)→ 删项目 → 审计,顺序不变;不做级联删除", () => {
    const src = strip(read("lib/projects/long-ops.ts"));
    const iInv = src.indexOf("await inventoryProject(projectId)");
    const iBlock = src.indexOf("inv.blockers.length > 0");
    const iEnq = src.indexOf("await enqueueProjectCredReclaim(projectId");
    const iDel = src.indexOf("await deleteProject(projectId)");
    const iAudit = src.indexOf('"project.delete"');
    expect(iInv).toBeGreaterThan(0);
    expect(iBlock).toBeGreaterThan(iInv);
    expect(iEnq).toBeGreaterThan(iBlock);
    expect(iDel).toBeGreaterThan(iEnq);
    expect(iAudit).toBeGreaterThan(iDel);
    expect(src).toContain("new LongOpHttpError(\n      400,");
    expect(src).toContain('code: "VALIDATION_FAILED"');
    expect(src).toContain("503,");
    expect(src).toContain('"project.delete.cred-reclaim-refused"');
    expect(src).not.toMatch(/DeleteCommand/);
    expect(src).not.toContain("pending");
  });

  it("项目页:删除只发一次 DELETE(拦截器负责 202 轮询),进度文字恒「删除中…」,专用 warming 分支 / 常量不留;进度 testid 保留", () => {
    const src = strip(read("app/projects/page.tsx"));
    expect(src).not.toContain("PROJECT_DELETE_WARMING");
    expect(src).not.toContain("res.status === 202");
    expect(src).not.toContain("retryAfterMs");
    expect(src).not.toContain("正在唤醒数仓");
    expect(src).toContain('data-testid="project-delete-progress"');
    expect(src).toContain('t("删除中…")');
    expect(src).not.toContain("d?.success ? (message.success(t(\"已删除\")), fetchProjects())");
  });

  it("词典:「删除中…」有译;退役的三条 warming 文案已从词典删除(不留死条目)", () => {
    expect(EN["删除中…"]).toBeTruthy();
    expect(EN["删除中…"]).not.toMatch(/[一-鿿]/);
    for (const zh of [
      "正在唤醒数仓并盘点数据面表数：已等 {sec} 秒，{next} 秒后自动再试（项目未删，无需重复点击）",
      "数仓唤醒超时（已等 {sec} 秒），项目未删；请稍后再点一次「删除」",
      "正在唤醒数仓，稍后自动重试…",
    ]) {
      expect(EN[zh], `${zh} 应已删除`).toBeUndefined();
    }
    expect(EN["删除项目空间"], "长操作标签(页面右下「正在后台执行:删除项目空间」)要有英文").toBeTruthy();
  });
});
