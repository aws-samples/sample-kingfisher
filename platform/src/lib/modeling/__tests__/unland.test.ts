// `unlandFromTarget`(解绑并清理的 DROP 一步)—— 真调实现,打桩只到 AWS SDK 边界(与 landing.test.ts 同一条纪律)。
//   ① 表不存在 ⇒ **一条语句都不执行**(零副作用);
//   ② 存在 ⇒ 恰好一条 `DROP TABLE IF EXISTS <schema>.<table>`,前后各观测一次;
//   ③ DROP 后仍观测到 ⇒ 抛错(调用方据此不去记录)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  existing: {} as Record<string, string | null>,
  executed: [] as Array<{ region: string; sql: string }>,
  /** DROP 之后库里是否真的没了(用来造「DROP 执行了但仍观测到」) */
  dropTakesEffect: true,
}));

vi.mock("@aws-sdk/client-redshift-data", () => {
  class ExecuteStatementCommand {
    constructor(public input: any) {}
  }
  class DescribeStatementCommand {
    constructor(public input: any) {}
  }
  class GetStatementResultCommand {
    constructor(public input: any) {}
  }
  return { ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand };
});

vi.mock("@/lib/exec-env/target-clients", () => ({
  redshiftDataClientFor: vi.fn((region: string) => {
    let lastSql = "";
    return {
      async send(cmd: any) {
        const name = cmd.constructor.name;
        if (name.startsWith("ExecuteStatement")) {
          lastSql = String(cmd.input.Sql);
          if (!/^SELECT column_name/.test(lastSql)) {
            h.executed.push({ region, sql: lastSql });
            if (/^DROP TABLE IF EXISTS/.test(lastSql) && h.dropTakesEffect) h.existing[region] = null;
          }
          return { Id: `stmt-${h.executed.length}` };
        }
        if (name.startsWith("DescribeStatement")) return { Status: "FINISHED", HasResultSet: /^SELECT column_name/.test(lastSql) };
        const sig = h.existing[region];
        if (!sig) return { Records: [] };
        return {
          Records: sig.split(",").map((p) => {
            const [n, ty] = p.split(":");
            const m = ty.match(/^([a-z]+)\((\d+)\)$/);
            const base = m ? m[1] : ty;
            const std = base === "varchar" ? "character varying" : base;
            return [{ stringValue: n }, { stringValue: std }, m ? { longValue: Number(m[2]) } : { isNull: true }, { isNull: true }, { isNull: true }];
          }),
        };
      },
    };
  }),
}));

vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (args: { targetId?: string }) => {
      const tid = args.targetId || "tgt_home";
      return { targetId: tid, region: tid, workgroup: "wg", database: "dev", secretArn: "arn:x", home: tid === "tgt_home", jurisdiction: "home" };
    }),
  };
});

import { unlandFromTarget as unlandFromTargetRaw } from "@/lib/modeling/landing";
// landing 的 Redshift Data 轮询经 awaitTerminal(无长操作 / 后台等待者上下文即抛 —— 路由侧由 submitLongOp 提供);
//   判据直接调库函数,所以在 op 帧里调(与真路由同一条路;「无上下文即抛」本身由 lib/long-ops/__tests__/context-await.test 钉)。
import { runInLongOp } from "@/lib/long-ops/context";
const inOp = <T,>(fn: () => Promise<T>): Promise<T> => runInLongOp({ taskId: "test", opKind: "modeling-land" }, fn);
const unlandFromTarget: typeof unlandFromTargetRaw = (...a) => inOp(() => unlandFromTargetRaw(...a));

const HOME = "tgt_home";
beforeEach(() => {
  h.existing = {};
  h.executed.length = 0;
  h.dropTakesEffect = true;
});

describe("unlandFromTarget", () => {
  it("表不存在 ⇒ dropped=false 且**零语句**(连 IF EXISTS 也不跑)", async () => {
    h.existing[HOME] = null;
    const r = await unlandFromTarget(HOME, { schema: "public", table: "dim_code_x" });
    expect(r).toEqual({ dropped: false, observedBefore: null });
    expect(h.executed).toEqual([]);
  });
  it("表存在 ⇒ 恰好一条 DROP TABLE IF EXISTS,dropped=true,带 DROP 前的观测签名", async () => {
    h.existing[HOME] = "value:varchar(64),label:varchar(256),seq:integer";
    const r = await unlandFromTarget(HOME, { schema: "public", table: "dim_code_x" });
    expect(h.executed.map((x) => x.sql)).toEqual(["DROP TABLE IF EXISTS public.dim_code_x"]);
    expect(r.dropped).toBe(true);
    expect(r.observedBefore).toContain("value:varchar(64)");
  });
  it("🔴 DROP 执行了但仍观测到 ⇒ 抛错(记录不许在库里还有表的时候去掉)", async () => {
    h.existing[HOME] = "value:varchar(64)";
    h.dropTakesEffect = false;
    await expect(unlandFromTarget(HOME, { schema: "public", table: "dim_code_x" })).rejects.toThrow(/仍观测到/);
    expect(h.executed.length, "DROP 确实发出过一次").toBe(1);
  });
});
