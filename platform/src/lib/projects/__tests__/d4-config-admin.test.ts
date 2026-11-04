// 🔴 **D4 门禁**:权限收紧的判据 + 落点覆盖 + 删项目前置校验的清单完整性。
//
// 【为什么"判据对"不等于"收紧了"】D4 的失效方式有三种,单测只覆盖第一种是不够的:
//   ① 判据写错(比如漏了"∧ 本项目 owner")—— 纯函数单测能逮;
//   ② 判据对,但**某个落点忘了用它**(改名收紧了、删项目没收紧)—— 只有扫描门禁能逮;
//   ③ 判据与落点都对,但**前端按钮用了另一份布尔表达式** ⇒ 按钮亮着却 403(用户眼里的故障)。
// ⇒ 本文件三种都钉。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  canCreateProject,
  canManageProjectConfig,
  CONFIG_ADMIN_DENY_MESSAGE,
  CREATE_PROJECT_DENY_MESSAGE,
} from "@/lib/projects/config-permissions";
import { PROJECT_RESOURCE_KINDS, PROJECT_RESOURCE_LABELS, PROJECT_SCOPED_NOT_COUNTED, countAllPages, safeCount, buildBlockers } from "@/lib/projects/project-resources";
import { PLATFORM_ADMIN_GROUP, MANAGER_GROUP, DEVELOPER_GROUP } from "@/lib/auth/groups";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

/** 🔴 扫描断言第一步永远是剥注释 —— 本批注释里逐字写着 `requireProjectConfigAdmin`,不剥就是假门禁。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function code(rel: string): string {
  return stripComments(readFileSync(resolve(SRC, rel), "utf8"));
}

const ADMIN = [PLATFORM_ADMIN_GROUP];
const MANAGER = [MANAGER_GROUP];
const DEVELOPER = [DEVELOPER_GROUP];
const NOGROUP: string[] = [];

describe("🔴 D4 判据:创建项目空间", () => {
  it("admin / manager 可建", () => {
    expect(canCreateProject(ADMIN)).toBe(true);
    expect(canCreateProject(MANAGER)).toBe(true);
    expect(canCreateProject([MANAGER_GROUP, DEVELOPER_GROUP])).toBe(true);
  });

  it("🔴 developer **不可**建(这就是本次收紧的那一刀)", () => {
    expect(canCreateProject(DEVELOPER)).toBe(false);
  });

  it("无组 / 空 / undefined 一律不可建(白名单式,不是「不在 viewer 组就放行」的反证式)", () => {
    expect(canCreateProject(NOGROUP)).toBe(false);
    expect(canCreateProject(undefined)).toBe(false);
    expect(canCreateProject(null)).toBe(false);
    expect(canCreateProject(["bgp-viewer", "bgp-analyst"])).toBe(false);
  });
});

describe("🔴 D4 判据:项目配置管理(改名/删项目/成员/审批决策)", () => {
  it("平台 admin 无论在项目里是什么角色都可以(跨项目超级用户)", () => {
    expect(canManageProjectConfig(ADMIN, "owner")).toBe(true);
    expect(canManageProjectConfig(ADMIN, "viewer")).toBe(true);
    expect(canManageProjectConfig(ADMIN, null)).toBe(true);
  });

  it("manager 必须**同时**是本项目 owner", () => {
    expect(canManageProjectConfig(MANAGER, "owner")).toBe(true);
    expect(canManageProjectConfig(MANAGER, "editor")).toBe(false);
    expect(canManageProjectConfig(MANAGER, "viewer")).toBe(false);
    expect(canManageProjectConfig(MANAGER, null)).toBe(false);
  });

  it("🔴 developer-owner **不能**管配置(拍板原文:仍可正常开发资源)", () => {
    expect(canManageProjectConfig(DEVELOPER, "owner")).toBe(false);
    expect(canManageProjectConfig(NOGROUP, "owner")).toBe(false);
  });

  it("🔴 判据严格窄于改动前(改动前 = myRole === owner):不存在「原来不能、现在能」的组合", () => {
    const roles = ["owner", "editor", "viewer", null] as const;
    const groupSets = [ADMIN, MANAGER, DEVELOPER, NOGROUP, [MANAGER_GROUP, DEVELOPER_GROUP]];
    for (const g of groupSets) {
      for (const r of roles) {
        const before = r === "owner" || g.includes(PLATFORM_ADMIN_GROUP); // 旧判据(admin 经 resolveRole 也是 owner)
        const after = canManageProjectConfig(g, r);
        if (after) expect(before, `收紧反了:groups=${g} role=${r} 改动前拒、改动后放`).toBe(true);
      }
    }
  });

  it("403 文案带「找谁」的出口(交互 §1.2:不许裸 403)", () => {
    for (const m of [CONFIG_ADMIN_DENY_MESSAGE, CREATE_PROJECT_DENY_MESSAGE]) {
      expect(m).toContain("bgp-admin");
      expect(m).toContain("bgp-manager");
      expect(m).toMatch(/联系/);
    }
    // 配置管理那条还必须说明"开发权没变",否则用户会以为整个项目都被锁了。
    expect(CONFIG_ADMIN_DENY_MESSAGE).toMatch(/仍可正常开发/);
  });
});

describe("🔴 D4 落点覆盖:每个配置管理路由都必须过收紧后的守卫", () => {
  // 落点清单来自 52 DESIGN §D4:"project-service 权限判断 + /projects 页按钮显隐
  // + api/projects/[id]/** + api/approvals/[id]"。
  const FACES: Array<{ file: string; must: string[]; mustNot: string[] }> = [
    { file: "app/api/projects/[id]/route.ts", must: ["requireProjectConfigAdmin"], mustNot: [] },
    { file: "app/api/projects/[id]/members/route.ts", must: ["requireProjectConfigAdmin"], mustNot: [] },
    { file: "app/api/projects/[id]/members/[username]/route.ts", must: ["requireProjectConfigAdmin"], mustNot: [] },
    { file: "app/api/approvals/[id]/route.ts", must: ["requireProjectConfigAdmin"], mustNot: [] },
    { file: "app/api/approvals/route.ts", must: ["canManageProjectConfig"], mustNot: ['role !== "owner"'] },
    { file: "app/api/projects/route.ts", must: ["canCreateProject"], mustNot: ['includes("bgp-developer")'] },
  ];

  it.each(FACES)("$file 用收紧后的判据", ({ file, must, mustNot }) => {
    const src = code(file);
    for (const m of must) expect(src, `${file} 没有 ${m}`).toContain(m);
    for (const m of mustNot) expect(src, `${file} 仍残留旧判据 ${m}`).not.toContain(m);
  });

  it("🔴 写操作不许再直接用 requireProject(req, «owner») 判配置管理", () => {
    // 这是 ② 类失效(判据对但落点漏用)的直接钉子:凡是 projects/[id]/** 与 approvals/[id]
    // 里出现 `"owner"` 作为 requireProject 的 min,就说明有一条路径绕过了收紧。
    const offenders: string[] = [];
    for (const f of [
      "app/api/projects/[id]/route.ts",
      "app/api/projects/[id]/members/route.ts",
      "app/api/projects/[id]/members/[username]/route.ts",
      "app/api/approvals/[id]/route.ts",
    ]) {
      if (/requireProject\s*\(\s*req\s*,\s*"owner"/.test(code(f))) offenders.push(f);
    }
    expect(offenders, "这些文件仍在用旧的 owner 闸判配置管理").toEqual([]);
  });

  it("🔴 前端 /projects 页与后端**同源**(不许自己写一遍布尔表达式)", () => {
    const page = code("app/projects/page.tsx");
    expect(page, "按钮显隐没用共享判据").toContain("canManageProjectConfig");
    expect(page, "新建按钮没用共享判据").toContain("canCreateProject");
    // 旧的自制判据必须消失,否则两份会漂移。
    expect(page).not.toContain('myRole === "owner";');
  });
});

describe("🔴 D4 删项目前置校验:资源清单不许悄悄变短", () => {
  it("清单覆盖 17 类项目级资源(加了新的项目级资源类型必须同步加行)", () => {
    // 与 `project-resources.ts` 的三张表一一对应。数字写死:漏一类 = 漏一类孤儿资源。
    // 2026-09-05 「数据服务」下线(50 SPEC §3.9c):`data-api` 一类随之去掉,12 → 11;
    //   门禁 lib/__tests__/data-service-retired.test.ts 反向钉住它不许回来。
    // 2026-09-13:问数会话卡片是**第 12 类**项目级资源。
    //   🔴 它原来根本不在清单里 ⇒ 删项目会**悄悄留下**别人保存的卡片(判据 GC-15 要的就是这个)。
    // 2026-10-11:12 → 16(真环境清理 128 个夹具项目时,删完项目仍留下的东西):
    //   · `copilot-plan`         —— 未收口的 Copilot 执行计划(还会被确认 / 被 L3 推进 / 还会建出作业);已收口的是历史,不数;
    //   · `governance-schedule`  —— 定时治理任务:载体在该区 MWAA Serverless 上**到点照样触发**(还在真跑的孤儿);
    //   · `seed-schedule`        —— 定时造数任务:同上;
    //   · `genbi-card-schedule`  —— 问数卡片定时刷新:随卡片走,单列是为了数出「卡片已删、定时还在」的不一致。
    //   后三类从闭合词表 `ACTION_SCHEDULE_TASK_TYPES` 派生(新增调度对象种类自动进清单,标签表缺项 tsc 不过)。
    //   · `backfill-plan`        —— 未收口的补数计划(会被 tick 推进、在执行区真跑实例;同 copilot-plan 只数未收口)。
    //   🔴 运维知识库 `incident` **不在**清单里:自动归并的派生知识、不会跑、没有删除入口(理由写在 PROJECT_SCOPED_NOT_COUNTED,下一条钉住)。
    //   🔴 per-project 凭证 secret **不在**清单里:它是系统代管的,删项目后由回收作业自动删(project-cred-reclaim.ts),不让人处置。
    expect(PROJECT_RESOURCE_KINDS.length).toBe(17);
    for (const k of [
      "datasource", "sync", "etl", "engine", "flink", "workflow", "redshift-task",
      "genbi-card",
      "bi-report", "genbi-context", "genbi-skill", "alert-rule",
      "copilot-plan", "governance-schedule", "seed-schedule", "genbi-card-schedule",
      "backfill-plan",
    ]) {
      expect(PROJECT_RESOURCE_KINDS, `清单缺 ${k}`).toContain(k);
    }
  });

  it("「按项目存但刻意不数」的类型有登记、有理由,且与清单不相交", () => {
    for (const k of ["incident", "project-credential"]) {
      expect(PROJECT_SCOPED_NOT_COUNTED[k], `${k} 的不数理由不见了`).toBeTruthy();
      expect(PROJECT_SCOPED_NOT_COUNTED[k].length).toBeGreaterThan(20);
    }
    for (const k of Object.keys(PROJECT_SCOPED_NOT_COUNTED)) {
      expect(PROJECT_RESOURCE_KINDS, `${k} 既说不数又在清单里`).not.toContain(k);
    }
  });

  it("清单里 7 个 attr 型资源与「按 projectId 过滤读」的那 7 条路径同一批表", () => {
    // 反向核实:每条读路径都用 projectFilter(),说明这类资源确实按项目隔离 ⇒ 删项目时必须数它。
    const routes = [
      "app/api/datasources/route.ts",
      "app/api/sync/route.ts",
      "app/api/etl-jobs/route.ts",
      "app/api/engines/[engine]/route.ts",
      "app/api/flink/jobs/route.ts",
      "app/api/workflow/route.ts",
      "app/api/redshift/tasks/route.ts",
    ];
    for (const r of routes) expect(code(r), `${r} 不再按项目过滤?`).toContain("projectFilter");
  });

  it("DELETE 路由经长操作 project-delete,执行体真的调了盘点、且**不做级联删除**", () => {
    // 主体搬进 lib/projects/long-ops.ts(路由只留鉴权 + submitLongOp)
    const route = code("app/api/projects/[id]/route.ts");
    expect(route).toContain('kind: "project-delete"');
    expect(route).toMatch(/submitLongOp\(/);
    expect(route).not.toContain("inventoryProject(");
    const src = code("lib/projects/long-ops.ts");
    expect(src).toContain("inventoryProject");
    expect(src).toContain("blockers");
    // 级联删除的形状(在 DELETE 里循环删资源表)一处都不许有。
    expect(route).not.toMatch(/DeleteCommand/);
    expect(src).not.toMatch(/DeleteCommand/);
  });

  // 🔴 这一条曾经是**假门禁**:只扫源码里有没有 `LastEvaluatedKey`/`ExclusiveStartKey` 两个词。
  //    我把 `ExclusiveStartKey = res.LastEvaluatedKey` 变异成 `= undefined`(只数第一页)⇒
  //    两个词都还在、门禁全绿。⇒ 改成**跑一遍**:喂一个两页的假 pager,断总数。
  it("🔴 盘点必须翻完所有页(只数第一页 ⇒ 大表上数出偏小值 ⇒ fail-open 放行删除)", async () => {
    const pages = [
      { Count: 2, LastEvaluatedKey: { pk: "a" } },
      { Count: 3, LastEvaluatedKey: { pk: "b" } },
      { Count: 1 }, // 末页无 LastEvaluatedKey
    ];
    const seen: Array<Record<string, unknown> | undefined> = [];
    let i = 0;
    const total = await countAllPages(async (startKey) => {
      seen.push(startKey);
      return pages[i++];
    });
    expect(total, "没有把每一页的 Count 累加起来").toBe(6);
    expect(seen.length, "没有按 LastEvaluatedKey 继续翻页").toBe(3);
    expect(seen[0], "第一页不该带 startKey").toBeUndefined();
    expect(seen[1]).toEqual({ pk: "a" });
    expect(seen[2]).toEqual({ pk: "b" });
  });

  it("翻页有兜底上限(异常 pager 永远返回 LastEvaluatedKey 也不会挂死)", async () => {
    let calls = 0;
    const total = await countAllPages(async () => {
      calls++;
      return { Count: 1, LastEvaluatedKey: { pk: "loop" } };
    }, 7);
    expect(calls).toBe(7);
    expect(total).toBe(7);
  });

  // ── 🔴🔴 2026-09-13:把「读不到 ⇒ 当成没有」这个 fail-open 钉死(全部**可执行**,不扫源码)──
  // 病史:`OWN_LIST_KINDS` 那一行原来写 `t.list(projectId).catch(() => [])` ⇒ BI 报表 / 问数口径 /
  // 技能 / 告警规则任意一类读失败就计 0 ⇒ 不阻断 ⇒ 带着孤儿把项目删了。
  describe("🔴 没能核实 ≠ 没有(safeCount + buildBlockers)", () => {
    it("safeCount:读成功回真实数;读失败回 count=null 且带脱敏原因(不回 0)", async () => {
      const ok = await safeCount("k", "某类", async () => 3);
      expect(ok).toEqual({ kind: "k", label: "某类", count: 3 });

      const bad = await safeCount("k", "某类", async () => {
        throw new Error("AccessDenied: arn:aws:iam::123456789012:role/whatever 不允许 Scan");
      });
      expect(bad.count, "🔴 读失败被当成了 0 —— 这正是会放行删除的那个洞").toBeNull();
      expect(bad.error, "没带原因,管理员无从下手").toBeTruthy();
      // blockers 会经 HTTP + 审计外泄 ⇒ 账号号/ARN 必须已脱敏(红线)。
      expect(bad.error).not.toMatch(/\d{12}/);
      expect(bad.error).not.toMatch(/arn:aws/);
    });

    it("buildBlockers:count=null **必须**成为阻断项(与 count=0 的行为相反)", () => {
      const schemaOk = { tables: 0, check: "ok" as const };
      const zero = buildBlockers({
        counted: [{ kind: "genbi-card", label: "问数会话卡片", count: 0 }],
        otherMembers: 0, schemaName: "proj_x", schema: schemaOk,
      });
      expect(zero, "真的是 0 就该放行").toEqual([]);

      const nul = buildBlockers({
        counted: [{ kind: "genbi-card", label: "问数会话卡片", count: null, error: "Throttling" }],
        otherMembers: 0, schemaName: "proj_x", schema: schemaOk,
      });
      expect(nul.length, "🔴 没能核实却放行了 = fail-open").toBe(1);
      expect(nul[0]).toContain("无法核实");
      expect(nul[0]).toContain("问数会话卡片");
      expect(nul[0]).toContain("已拒绝删除");
    });

    it("buildBlockers:有卡片就阻断,且文案说清「要本人删」(不做级联删除)", () => {
      // 🔴 label 必须取**产品里真实那一行**(不是我在判据里手写一份):
      //    变异测试逮到过 —— 手写一份的话,把产品标签改坏判据照样绿。
      const cardLabel = PROJECT_RESOURCE_LABELS["genbi-card"];
      expect(cardLabel, "清单里没有 genbi-card 的标签").toBeTruthy();
      // 项目是共享的、卡片是个人的 ⇒ 标签本身就得指向「本人删除」,否则管理员会以为平台坏了。
      expect(cardLabel, "🔴 阻断文案没说要本人删 ⇒ 管理员会以为平台坏了").toContain("需本人删除");
      const b = buildBlockers({
        counted: [{ kind: "genbi-card", label: cardLabel, count: 7 }],
        otherMembers: 0, schemaName: "proj_x", schema: { tables: 0, check: "ok" },
      });
      expect(b.length).toBe(1);
      expect(b[0]).toContain("7 个");
      expect(b[0]).toContain("需本人删除");
    });
  });

  it("数仓核实不到时 fail-closed(不当 0 放行)", () => {
    const src = code("lib/projects/project-resources.ts");
    expect(src).toContain("unavailable");
    // 「没核实」必须走进 blockers(而不是被当成 0 放行)。断真实代码形状,不断我记忆里的字段名。
    expect(src).toMatch(/check === "unavailable"[\s\S]{0,300}blockers\.push/);
    expect(src).toMatch(/已拒绝删除/);
  });
});

describe("🔴 组名 SSOT:不许再出现字面量副本", () => {
  it("D4 的判据文件从 @/lib/auth/groups 取组名(不写字面量)", () => {
    const src = code("lib/projects/config-permissions.ts");
    expect(src).toContain('from "@/lib/auth/groups"');
    expect(src).not.toContain('"bgp-manager"');
    expect(src).not.toContain('"bgp-admin"');
  });

  it("identity.ts 仍然导出这三个常量(既有 import 路径零改动)", () => {
    const src = code("lib/auth/identity.ts");
    expect(src).toContain("PLATFORM_ADMIN_GROUP");
    expect(src).toContain("MANAGER_GROUP");
    expect(src).toContain("DEVELOPER_GROUP");
    expect(PLATFORM_ADMIN_GROUP).toBe("bgp-admin");
    expect(MANAGER_GROUP).toBe("bgp-manager");
    expect(DEVELOPER_GROUP).toBe("bgp-developer");
  });
});
