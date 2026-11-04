// 「写了 ≠ 接上了」:数据目录建表 / 改表的接缝判据(查调用位置,不查 token 出现过)。
//   ① 四条路由存在;写路由落点来自请求体 / URL 的 targetId(requestedTargetId / validateCreateSpec),不读 scope;
//   ② prod 门控:两条写路由都走 isProtectedEnv(getActiveEnv) ⇒ createApproval(type = DDL_APPROVAL_TYPE),审批路由批准分支调 executeApprovedDdl;
//   ③ 改表编排:区域审计写在执行**之前**;非主控区先写台账 pendingAlter 再调执行器 alter-model-table;执行器模板已登记;
//   ④ 治理页挂了向导 + 抽屉,目录行只给 Redshift 表「修改表结构」,S3 Tables 行置灰并说明;项目空间认得 ddl 审批单。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");
function code(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("{/*"))
    .join("\n");
}
const before = (src: string, a: string, b: string, why: string) => {
  const ia = src.indexOf(a);
  const ib = src.indexOf(b);
  expect(ia, `${why}:缺 ${a}`).toBeGreaterThanOrEqual(0);
  expect(ib, `${why}:缺 ${b}`).toBeGreaterThanOrEqual(0);
  expect(ia, why).toBeLessThan(ib);
};

describe("① 路由与落点", () => {
  it("四条路由在;写路由不读 scope,落点只来自请求", () => {
    for (const rel of ["app/api/governance/tables/route.ts", "app/api/governance/tables/preview/route.ts", "app/api/governance/tables/columns/route.ts", "app/api/governance/tables/alter/route.ts"]) {
      expect(existsSync(join(SRC, rel)), rel).toBe(true);
      const c = code(rel);
      expect(c, `${rel} 不许读 scope`).not.toMatch(/readScope\(|requireScope\(/);
    }
    expect(code("app/api/governance/tables/route.ts")).toContain("const spec = validateCreateSpec(body)");
    expect(code("app/api/governance/tables/alter/route.ts")).toContain('requestedTargetId(body?.targetId, "governance.tables.alter")');
    expect(code("app/api/governance/tables/columns/route.ts")).toContain('requestedTargetId(q.get("targetId"), "governance.tables.columns")');
  });
});

describe("② prod 门控与审批", () => {
  it("建表 / 改表路由:isProtectedEnv(getActiveEnv) ⇒ createApproval(type = DDL_APPROVAL_TYPE) 回 202", () => {
    // 建表:审批分流留在路由(不打数仓)
    const create = code("app/api/governance/tables/route.ts");
    expect(create).toContain("const env = getActiveEnv(req)");
    expect(create).toContain("if (isProtectedEnv(env))");
    expect(create).toContain("type: DDL_APPROVAL_TYPE");
    expect(create).toMatch(/apiOk\(\{ pending: true, approvalId: approval\.approvalId, env[^}]*\}, 202\)/);
    // 改表:三个分支都要先读目标区真实列 ⇒ 整段进执行体;路由只按环境选 mode,执行体里建审批单并以 202 同形回
    const alter = code("app/api/governance/tables/alter/route.ts");
    expect(alter).toContain("const env = getActiveEnv(req)");
    expect(alter).toContain('const mode = isProtectedEnv(env) ? "request-approval" : "execute"');
    expect(alter).toContain('kind: "catalog-alter-table"');
    const ex = code("lib/governance/long-ops.ts");
    expect(ex).toContain('if (mode === "request-approval")');
    expect(ex).toContain("type: DDL_APPROVAL_TYPE");
    expect(ex).toMatch(/data: \{ pending: true, approvalId: approval\.approvalId, env[^}]*\}, resultStatus: 202/);
  });
  it("审批路由:批准 ddl 单 ⇒ executeApprovedDdl(payload 形状先过 isDdlApprovalPayload)", () => {
    const c = code("app/api/approvals/[id]/route.ts");
    expect(c).toContain('if (decision === "approved" && approval.type === DDL_APPROVAL_TYPE)');
    // 执行搬进执行体(approval-execute-ddl),路由先验形状再提交;执行体由批准人身份派生 actor 调 executeApprovedDdl
    before(c, "isDdlApprovalPayload(approval.payload)", 'kind: "approval-execute-ddl"', "先验形状再提交");
    const ex = code("lib/governance/long-ops.ts");
    expect(ex).toMatch(/executeApprovedDdl\(payload, actorContextOf\(ctx\.identity\)\)/);
    expect(ex).toContain("actor: actorFromIdentity(identity)");
  });
  it("项目空间页认得 ddl 审批单(标签 / 文案不再落到「申请加入项目」)", () => {
    const c = code("app/projects/page.tsx");
    expect(c).toContain('a.type === "ddl"');
    expect(c).toContain("ddlApprovalText(a)");
  });
});

describe("③ 改表编排", () => {
  it("alter-service:区域审计在执行之前;非主控区 setPendingAlter → executeAdminDdl(alter-model-table) → 清计划;dryRun 不审不执行", () => {
    const c = code("lib/modeling/alter-service.ts");
    before(c, 'entry: "modeling-land"', "await execOnBinding(b, statements)", "home:审计在执行之前");
    before(c, 'entry: "modeling-land"', 'operation: "alter-model-table"', "非主控区:审计在执行之前");
    before(c, "await setPendingAlter(modelTableId, plan)", 'operation: "alter-model-table"', "先写台账计划再调执行器");
    before(c, 'operation: "alter-model-table"', "await setPendingAlter(modelTableId, null)", "执行完清计划");
    before(c, "if (opts.dryRun) return", 'entry: "modeling-land"', "dryRun 不写审计");
    expect(c).toContain("if (plan.dropColumns.length && String(opts.confirmName || \"\") !== t.physicalTable)");
  });
  it("执行器:alter-model-table 登记在 operation 清单 / 策略表 / 模板,模板只从台账 pendingAlter 生成", () => {
    expect(code("lib/exec-env/admin-ddl-request.ts")).toContain('"alter-model-table",');
    expect(code("lib/exec-env/admin-ddl-executor.ts")).toContain('"alter-model-table": { requirePlatformAdmin: true, requireApproval: false, auditKind: "model-table" }');
    const t = code("lib/exec-env/admin-ddl-templates.ts");
    expect(t).toContain('"alter-model-table": (req, ctx) => {');
    expect(t).toContain("buildAlterTableStatements({ schema: f.schema, physicalTable: f.table, plan: o.pendingAlter }).map(brandStatement)");
  });
  it("建表编排:Redshift 走 createModelTable(origin catalog)+ applyModelTableById(同建模页);S3 Tables 走 CreateTableCommand(ICEBERG)", () => {
    const c = code("lib/governance/catalog-ddl.ts");
    expect(c).toContain('origin: "catalog",');
    before(c, "await createModelTable(", "await applyModelTableById(t.modelTableId, ctx.username, {", "先登记台账再落地");
    expect(c).toContain('format: "ICEBERG"');
    expect(c).toContain("metadata: { iceberg: { schema: { fields } } }");
    expect(c).toContain('origin: "catalog-adopted"');
  });
});

describe("④ 治理页接线", () => {
  it("「新建表」按钮(admin)+ 向导 + 抽屉挂在目录页签;Redshift 行「修改表结构」可点,S3 Tables 行置灰并说明", () => {
    const c = code("app/governance/page.tsx");
    expect(c).toContain('data-testid="catalog-new-table-btn" onClick={() => setCreateOpen(true)}');
    expect(c).toContain("<CreateTableWizard open={createOpen}");
    expect(c).toContain("<AlterTableDrawer open={!!alterTarget} target={alterTarget}");
    expect(c).toMatch(/r\.type === "redshift"\s*\?\s*<Button size="small" data-testid="catalog-alter-btn" onClick=/);
    expect(c).toMatch(/<Button size="small" data-testid="catalog-alter-btn" disabled title=/);
  });
  it("向导 / 抽屉:预览与执行都打自己的路由;执行走 fetchWithResidencyAck(跨法域首次操作要免责告知)", () => {
    const w = code("components/governance/CreateTableWizard.tsx");
    expect(w).toContain('fetch("/api/governance/tables/preview"');
    expect(w).toMatch(/fetchWithResidencyAck\(\s*"\/api\/governance\/tables",/);
    const d = code("components/governance/AlterTableDrawer.tsx");
    expect(d).toContain("fetch(`/api/governance/tables/columns?targetId=${encodeURIComponent(target.targetId)}");
    expect(d).toMatch(/fetchWithResidencyAck\(\s*"\/api\/governance\/tables\/alter",/);
    expect(d).toContain("confirmName.trim() !== (target?.table || \"\")");
  });
});
