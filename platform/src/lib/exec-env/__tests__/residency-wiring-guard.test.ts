// 🔴 接线守卫(ACCEPTANCE):白名单入口**全部**先同意前置再区域审计;定时路径观测后补写;前端弹窗接在每个入口上。
// 为什么必须是静态守卫:审计完整性是「少接一处就漏一处」的性质 —— 单测跑不到那条路由就永远绿。
// 变异 M-e:注释掉 execute 路由里的 requireResidencyAckForTargets 或 multi-region-query 里的 residencyAudit ⇒ 本文件红。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESIDENCY_ENTRIES } from "@/lib/exec-env/residency";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
    const fp = resolve(dir, e);
    if (statSync(fp).isDirectory()) walk(fp, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(fp);
  }
  return acc;
};
/** `needle` 在 `hay` 里首次出现的位置必须早于 `after` 的首次出现(两者都必须存在)。 */
function before(hay: string, needle: string, after: string, why: string) {
  const i = hay.indexOf(needle);
  const j = hay.indexOf(after);
  expect(i, `${why}:缺 ${needle}`).toBeGreaterThan(-1);
  expect(j, `${why}:缺 ${after}`).toBeGreaterThan(-1);
  expect(i, `${why}:${needle} 必须在 ${after} 之前`).toBeLessThan(j);
}

describe("🔴 白名单入口逐个点名(SPEC v3.23 §3.2)", () => {
  it("直查:路由先对全部 target 同意前置;提交层在 ExecuteStatement **之前**写区域审计,并把 auditId 带回 submission", () => {
    const route = strip(read("app/api/redshift/execute/route.ts"));
    expect(route).toContain("requireResidencyAckForTargets(sctx.identity, targets)");
    expect(route).toContain("residencyErrorResponse(");
    before(route, "requireResidencyAckForTargets(", "submitToTargets({", "同意前置要在扇出之前");
    const mrq = strip(read("lib/redshift/multi-region-query.ts"));
    before(mrq, "residencyAudit({", "new ExecuteStatementCommand({", "区域审计要在提交之前");
    expect(mrq).toContain('entry: "execute"');
    expect(mrq).toContain("knownJurisdiction: binding.jurisdiction");
    expect(mrq).toContain("...(auditId ? { auditId } : {})");
    //  statement ↔ 审计关联:execute 审计在提交前写(行内无 statementId),靠 StatementName == auditId 反查
    expect(mrq).toContain("...(auditId ? { StatementName: auditId } : {})");
  });
  it("取结果:handle 校验之后、GetStatementResult 之前写区域审计,落点取 handle.targetId", () => {
    const src = strip(read("app/api/redshift/result/[id]/route.ts"));
    before(src, "requireQueryHandle(req, params.id", "residencyAudit({", "先校验句柄再审计");
    before(src, "residencyAudit({", "new GetStatementResultCommand({ Id: params.id })", "审计要在取行之前");
    expect(src).toContain("targetId: handleTarget");
    expect(src).toContain('entry: "result"');
  });
  it("关联回查:admin 端点用 ListStatements(StatementName=auditId, RoleLevel) 在 target 所在 region 反查语句;只回 id / 状态 / 时间,不回 SQL", () => {
    // 🔴 Data API 的 ListStatements / DescribeStatement 按**调用者 IAM 身份**隔离(DescribeStatement 也不回 StatementName)⇒
    //    只有语句 owner(平台 TaskRole)能看到 StatementName == auditId 这层关联;没有这个端点,合同里的关联就是「谁也观测不到」的空话。
    const src = strip(read("app/api/admin/exec-envs/[targetId]/statements/route.ts"));
    expect(src).toContain("requireExecEnvAdmin(");
    expect(src).toContain("new ListStatementsCommand({");
    expect(src).toContain("StatementName: auditId");
    expect(src).toContain("RoleLevel: true");
    expect(src).toContain("redshiftDataClientFor(requireTargetRegion(t))");
    expect(src).toContain("s.StatementName === auditId");
    expect(src).not.toContain("QueryString");
  });
  it("SQL 历史:POST 对跨法域行不存 sql、原文进区域结果表;GET .../[historyId]/sql 先审计(entry=history)再读区域表", () => {
    const post = strip(read("app/api/redshift/history/route.ts"));
    expect(post).toContain("putRegionSqlHistory(");
    expect(post).toContain('residency: "region"');
    expect(post).toContain("sqlForCentral = undefined");
    const get = strip(read("app/api/redshift/history/[historyId]/sql/route.ts"));
    before(get, "residencyAudit({", "getRegionSqlHistory(", "读原文之前先审计");
    expect(get).toContain('entry: "history"');
    expect(get).toContain("guardResourceAccess(");
  });
  it("建模落地:码表 land / 维表 apply 都在 landToTargets **之前**逐 target 审计(entry=modeling-land),probeOnly 不审;路由传用户 actor", () => {
    for (const rel of ["lib/modeling/service.ts", "lib/modeling/dimensions.ts"]) {
      const src = strip(read(rel));
      before(src, 'entry: "modeling-land"', "await landToTargets({", `${rel}:审计要在落地之前`);
      expect(src).toContain("if (!opts.probeOnly)");
      expect(src).toContain("auditActorOrService(opts.residencyActor)");
    }
    // 两条路由的主体搬进执行体(lib/modeling/long-ops.ts),用户 actor 由承载请求的身份派生;路由经 submitLongOp 提交自己的 kind
    const ex = strip(read("lib/modeling/long-ops.ts"));
    expect(ex.match(/residencyActor: userActor\(ctx\.identity\)/g)?.length, "落地 / 应用两个执行体都传用户 actor").toBe(2);
    expect(ex).toContain("residencyErrorResponse");
    for (const [rel, kind] of [["app/api/modeling/codetables/[id]/land/route.ts", "modeling-land"], ["app/api/modeling/dimensions/[id]/apply/route.ts", "modeling-apply"]] as const) {
      const src = strip(read(rel));
      expect(src, rel).toContain(`kind: "${kind}"`);
      expect(src, rel).toContain("longOpErrorResponse(e)");
    }
  });
  it("运行提交:三条 job-service 路径 + EMR provider 都在抢锁 / 提交之前审计(entry=run-submit),run 行带 residencyAuditId", () => {
    const js = strip(read("lib/etl/job-service.ts"));
    const glue = js.slice(js.indexOf("export async function runGlueScriptJob"), js.indexOf("export async function runRedshiftSqlJob"));
    const rs = js.slice(js.indexOf("export async function runRedshiftSqlJob"), js.indexOf("export async function dryRunRedshiftSqlJob"));
    const dry = js.slice(js.indexOf("export async function dryRunRedshiftSqlJob"), js.indexOf("export async function runEtlJob"));
    before(glue, "residencyAudit({", "acquireJobRunLock(", "Glue:审计在抢锁之前");
    before(rs, "residencyAudit({", "acquireJobRunLock(", "Redshift:审计在抢锁之前");
    before(dry, "residencyAudit({", "new BatchExecuteStatementCommand({", "试运行:审计在 EXPLAIN 之前");
    for (const seg of [glue, rs, dry]) {
      expect(seg).toContain('entry: "run-submit"');
      expect(seg).toContain("auditActorOrService(opts.actor)");
      expect(seg).toContain("residencyAuditId");
    }
    const emr = strip(read("lib/engines/emr/provider.ts"));
    before(emr, "residencyAudit({", "acquireJobRunLock(", "EMR:审计在抢锁之前");
    expect(emr).toContain('entry: "run-submit"');
    expect(emr).toContain("residencyAuditId");
  });
  it("六条运行路由:用户 actor 传下去 + 残留错误映射;run 路由先对全部 target 同意前置", () => {
    // 引擎运行的提交段在长操作执行体 lib/engines/long-ops.ts —— 路由仍做同意前置 + 残留错误映射;actor 由执行体从 ctx.identity 派生、auditUnavailable 分类也在执行体
    const runRoutes = ["app/api/etl-jobs/[id]/run/route.ts"];
    const otherRoutes = [
      "app/api/etl-jobs/[id]/rerun/route.ts",
      "app/api/etl-jobs/[id]/backfill/route.ts",
      "app/api/engines/[engine]/[id]/rerun/route.ts",
      "app/api/engines/[engine]/[id]/backfill/route.ts",
    ];
    for (const rel of runRoutes) {
      const src = strip(read(rel));
      expect(src, rel).toContain("requireResidencyAckForTargets(guard.identity, runTargets)");
      expect(src, rel).toContain("userActor(guard.identity)");
      expect(src, rel).toContain("residencyErrorResponse(");
      expect(src, rel).toContain("auditUnavailable");
    }
    {
      const route = strip(read("app/api/engines/[engine]/[id]/run/route.ts"));
      expect(route).toContain("requireResidencyAckForTargets(guard.identity, runTargets)");
      expect(route).toContain("residencyErrorResponse(");
      const exec = strip(read("lib/engines/long-ops.ts"));
      expect(exec).toContain("userActor(ctx.identity)");
      expect(exec).toContain("auditUnavailable");
    }
    for (const rel of otherRoutes) {
      const src = strip(read(rel));
      expect(src, rel).toContain("userActor(guard.identity)");
      expect(src, rel).toContain("residencyErrorResponse(");
    }
  });
  it("注册路由:跨法域注册时 admin 的同意同时写 S13(source=register);acks 路由对旧 target 回落描述符行", () => {
    const reg = strip(read("app/api/admin/exec-envs/register/route.ts"));
    before(reg, "await registerTarget(", "putAck({", "先注册成功再写同意行");
    expect(reg).toContain('source: "register"');
    const acks = strip(read("app/api/admin/exec-envs/[targetId]/acks/route.ts"));
    expect(acks).toContain('!rows.some((r) => r.source === "register")');
  });
  it("定时路径观测后补写:两条 reconcile + 三条运行列表都调 auditObservedScheduledRun", () => {
    for (const rel of [
      "lib/etl/job-service.ts",
      "lib/engines/emr/provider.ts",
      "app/api/etl-jobs/[id]/runs/route.ts",
      "app/api/engines/[engine]/[id]/runs/route.ts",
      "app/api/monitor/runs/route.ts",
    ]) {
      expect(strip(read(rel)), rel).toContain("auditObservedScheduledRun(");
    }
  });
});

describe("🔴 纪律面", () => {
  const files = walk(SRC);
  it("skipAck: true 只出现在 residency-audit.ts(系统路径);带用户身份的入口不许跳过同意前置", () => {
    const hits = files.filter((fp) => strip(readFileSync(fp, "utf8")).includes("skipAck: true")).map((fp) => fp.slice(SRC.length + 1));
    expect(hits).toEqual(["lib/exec-env/residency-audit.ts"]);
  });
  it("entry 字面全部 ∈ RESIDENCY_ENTRIES,且五个 entry 各至少一个生产调用方(没调用方的 entry = 从未验证过的代码)", () => {
    const used = new Set<string>();
    for (const fp of files) {
      if (fp.endsWith("residency.ts")) continue;
      for (const m of strip(readFileSync(fp, "utf8")).matchAll(/entry: "([a-z-]+)"/g)) used.add(m[1]);
    }
    for (const u of used) expect(RESIDENCY_ENTRIES as readonly string[], `未登记的 entry ${u}`).toContain(u);
    for (const e of RESIDENCY_ENTRIES) expect(used, `entry ${e} 没有生产调用方`).toContain(e);
  });
  it("准入内核仍只有一份 serviceabilityVerdict(三处调用方共用;不许为审计另开一条准入路径)", () => {
    const registry = strip(read("lib/exec-env/registry.ts"));
    const calls = registry.split("serviceabilityVerdict(").length - 1;
    expect(calls).toBe(4); // 1 处定义 + 3 处调用
    expect(strip(read("lib/exec-env/residency-audit.ts"))).toContain("requireReadyTarget(targetId)");
    expect(strip(read("lib/exec-env/residency-audit.ts"))).not.toContain("?? homeTarget");
  });
  it("region 表只 Put / Get / Query:residency-store.ts 不 import Update / Delete / BatchWrite 命令", () => {
    const store = strip(read("lib/exec-env/residency-store.ts"));
    for (const bad of ["UpdateCommand", "DeleteCommand", "BatchWriteCommand", "TransactWriteCommand"]) expect(store).not.toContain(bad);
  });
  it("前端:四个入口都接了 fetchWithResidencyAck + useResidencyAck;弹窗只显示服务端下发的文案(不含文案字面)", () => {
    for (const rel of ["app/redshift/page.tsx", "components/modeling/LandingPanel.tsx", "app/etl-jobs/page.tsx", "components/engines/EmrJobPanel.tsx"]) {
      const src = strip(read(rel));
      expect(src, rel).toContain("fetchWithResidencyAck(");
      expect(src, rel).toContain("useResidencyAck()");
      expect(src, rel).toContain("{residencyModal}");
    }
    const modal = strip(read("components/residency/DisclaimerModal.tsx"));
    expect(modal).toContain("detail?.disclaimer.text");
    expect(modal).not.toContain("不承担任何");
    expect(strip(read("app/exec-envs/TargetDetail.tsx"))).toContain("/acks`");
  });
});
