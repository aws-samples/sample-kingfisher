// O1 —— 「哪些资源可以按执行范围计数」的**单一登记表** + 计数用的行读取。
//
// 合同:SPEC v3.34 §2.6.6(`GET /api/scope/counts`)。
//
// ── 为什么要有这张表 ──────────────────────────────────────────────────────────
// 护栏 1(INTERACTION §9.3-1「永远不让用户丢东西」)要在 target 视角常驻一条
// 「其他执行范围还有 N 条」。N 必须与 DDB 逐行核对得上(判据),所以「哪张表 /
// 有没有项目维 / 有没有环境维 / 归属怎么算」必须写成**数据**,不能散在各处 if。
//
// 🔴 **每一行都是从既有列表路由实测抄来的**,不是想当然(下面逐条标了来源 file:line);
// `resource-index-parity` 单测会读那些路由的源码,断言 clause 仍然一致 ——
// 逐页接入时,列表路由会改成直接调本文件,那份重复才真正消失。

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { projectFilter, envFilter } from "@/lib/projects/guard";
// 绑定字段名由补数模块自己导出(不在这里写字面量)
import { BACKFILL_PLAN_BINDING_ATTR } from "@/lib/backfill/types";
import type { Env } from "@/lib/projects/constants";

/**
 * 物理分区键 `userId` 恒 `"default-user"`(逻辑多租户,真实用户靠 `createdBySub` 区分)——
 * 这条不变量写在 `lib/engines/types.ts:13`,全仓 15+ 处各自 `const USER_ID = "default-user"`。
 * 本文件不新造语义,只是把它取过来;`resource-index-parity` 断言镜像的那几条路由仍是同一个值。
 */
export const LEGACY_PARTITION_USER_ID = "default-user";

/** 可计数的资源种类(SPEC §2.6.6 的 `resource` 值域)。 */
export const COUNTABLE_KINDS = [
  "etl-job",
  "engine-job",
  "sync",
  "workflow",
  "datasource",
  "model-table",
  "code-table",
  // 补数计划(绑定字段名是 `execTargets`,见 KIND_INDEX)
  "backfill-plan",
  // 运维知识库的故障类别主档。
  // 🔴 加进来的理由是护栏 1:单区视角下知识库常常是空的(那个区还没出过故障),
  // 而「空」与「这一页没接执行范围」在界面上长得一样 ⇒ 必须能说出「主控区有 N 条」。
  "incident",
] as const;
export type CountableKind = (typeof COUNTABLE_KINDS)[number];

export function isCountableKind(v: unknown): v is CountableKind {
  return typeof v === "string" && (COUNTABLE_KINDS as readonly string[]).includes(v);
}

/** 归属算法:`binding` = 行上 `targets[]`(经 `bindingTargets` 三级回落);`scalar` = 单值属性。 */
export type Attribution = "binding" | "scalar";

interface KindSpec {
  /** DDB 表名 */
  table: string;
  /**
   * 读法:
   * · `scan-user`  = 按 `userId + 项目(+环境)` Scan(镜像既有列表路由的 clause)
   * · `service-fn` = 🔴 **直接调既有的 list 服务函数**(建模两表 + 补数计划)——
   *   它们本来就是各自那张表的唯一读法(`listModelTables` / `listCodeTables` / `listPlans`),
   *   在这里另写一个 Query 就等于第二份读法,而且 pk 值差一个字母就会静默数出 0
   *   (实测建模两表的 pk 是小写 `modeltable` / `codetable`,不是我第一版想当然写的大写)。
   */
  read: "scan-user" | "service-fn";
  /** 有没有项目维 / 环境维(逐条实测,别推测) */
  hasProject: boolean;
  hasEnv: boolean;
  attribution: Attribution;
  /** `scalar` 用:属性名(与 `lib/exec-env/scope.ts` 的 `SCOPE_SCALAR_ATTR` 同源) */
  scalarKind?: "datasource";
  /**
   * `binding` 用:绑定列表的字段名。缺省 = `targets`。
   * 🔴 只有历史字段名不同的模块才填(实测仅补数计划 `execTargets`);填的值必须来自那个模块
   * 自己导出的常量,不许在这里写字面量(否则改名时这里悄悄漂),门禁 `scope-filter-guard` 钉住。
   */
  bindingAttr?: string;
  /** 镜像来源(给 parity 单测读) */
  mirrorOf: string;
}

/**
 * 🔴 逐条实测(2026-09-09):
 * · etl-job     `app/api/etl-jobs/route.ts:28-32`      —— userId + project + env
 * · engine-job  `app/api/engines/[engine]/route.ts:32` —— userId + engine + project + env(计数**跨全部引擎**,故不带 engine)
 * · sync        `app/api/sync/route.ts:29-35`          —— userId + project + env
 * · workflow    `app/api/workflow/route.ts:25`         —— userId + project + env
 * · datasource  `app/api/datasources/route.ts:32-35`   —— userId + project,**没有 env 维**(实测,别照抄别人加上)
 * · model-table `lib/modeling/dimensions.ts:94`        —— 平台级全局,Query pk,**没有项目/环境维**
 * · code-table  `lib/modeling/service.ts:197`          —— 同上
 * · backfill-plan `lib/backfill/service.ts:107`       —— **Query pk=`backfill#<projectId>`**(项目维在 pk 里,无环境维);
 *                                                       绑定字段名是 `execTargets` 而不是 `targets`
 */
export const KIND_INDEX: Record<CountableKind, KindSpec> = {
  "etl-job": { table: TABLES.ETL_JOBS, read: "scan-user", hasProject: true, hasEnv: true, attribution: "binding", mirrorOf: "app/api/etl-jobs/route.ts" },
  "engine-job": { table: TABLES.ENGINE_JOBS, read: "scan-user", hasProject: true, hasEnv: true, attribution: "binding", mirrorOf: "app/api/engines/[engine]/route.ts" },
  sync: { table: TABLES.SYNC_TASKS, read: "scan-user", hasProject: true, hasEnv: true, attribution: "binding", mirrorOf: "app/api/sync/route.ts" },
  workflow: { table: TABLES.WORKFLOWS, read: "scan-user", hasProject: true, hasEnv: true, attribution: "binding", mirrorOf: "app/api/workflow/route.ts" },
  datasource: { table: TABLES.DATASOURCES, read: "scan-user", hasProject: true, hasEnv: false, attribution: "scalar", scalarKind: "datasource", mirrorOf: "app/api/datasources/route.ts" },
  "model-table": { table: TABLES.MODEL_TABLES, read: "service-fn", hasProject: false, hasEnv: false, attribution: "binding", mirrorOf: "lib/modeling/dimensions.ts:listModelTables" },
  "code-table": { table: TABLES.CODE_TABLES, read: "service-fn", hasProject: false, hasEnv: false, attribution: "binding", mirrorOf: "lib/modeling/service.ts:listCodeTables" },
  "backfill-plan": { table: TABLES.BACKFILL_PLANS, read: "service-fn", hasProject: true, hasEnv: false, attribution: "binding", bindingAttr: BACKFILL_PLAN_BINDING_ATTR, mirrorOf: "lib/backfill/service.ts:listPlans" },
  // 🔴 `listMasters(projectId)` 是这张表的**唯一读法**
  // (pk = `incident#<projectId>`,项目维在 pk 里)。另写 Scan 会数进别的项目的故障类别。
  incident: { table: TABLES.INCIDENTS, read: "service-fn", hasProject: true, hasEnv: false, attribution: "binding", mirrorOf: "lib/incidents/store.ts:listMasters" },
};

/** 组出该 kind 的 Scan 过滤片段(与镜像来源逐字一致)。 */
export function countScanParams(
  kind: CountableKind,
  opts: { projectId: string; env: Env }
): { FilterExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
  const spec = KIND_INDEX[kind];
  const parts: string[] = ["userId = :uid"];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ":uid": LEGACY_PARTITION_USER_ID };
  if (spec.hasProject) {
    const pf = projectFilter(opts.projectId);
    parts.push(pf.clause);
    Object.assign(values, pf.values);
  }
  if (spec.hasEnv) {
    const ef = envFilter(opts.env);
    parts.push(ef.clause);
    names["#env"] = "env";
    Object.assign(values, ef.values);
  }
  return {
    FilterExpression: parts.join(" AND "),
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  };
}

/**
 * 读出该 kind 在当前项目 + 环境下的全部行。
 *
 * 🔴 **必须翻页翻到底**:DDB 的 `Limit`/单次返回是**过滤之前**的量,不翻页就会静默少报 ——
 * 而少报的表现是界面上「其他执行范围还有 3 条」而真实有 30 条,正是护栏 1 要防的那种「丢东西」。
 * (同一个坑在 `GET /api/monitor/runs` 上真出过,见该路由的分页单测。)
 */
export async function listRowsForCount(
  kind: CountableKind,
  opts: { projectId: string; env: Env }
): Promise<Array<Record<string, unknown>>> {
  const spec = KIND_INDEX[kind];
  if (spec.read === "service-fn") {
    // 🔴 复用既有唯一读法。⚠️ 已知登记:这几个函数**自己不翻页**(单次 Query),
    // 所以本 kind 的计数与对应的列表页**同口径地**受同一个上限约束 —— 这是有意的:
    // 计数比列表多算出几条,在界面上表现为「提示条说还有 N 条,点进去只有 M 条」,更难排查。
    // 真要修就得连列表一起修(登记在,之外)。
    if (kind === "model-table") {
      const { listModelTables } = await import("@/lib/modeling/dimensions");
      return (await listModelTables()) as unknown as Array<Record<string, unknown>>;
    }
    if (kind === "incident") {
      const { listMasters } = await import("@/lib/incidents/store");
      return (await listMasters(opts.projectId)) as unknown as Array<Record<string, unknown>>;
    }
    if (kind === "backfill-plan") {
      // 🔴 补数计划是 `Query pk=backfill#<projectId>`,不是 Scan:
      // `listPlans` 已经是这张表的唯一读法(项目维就在 pk 里),另写一个 Scan 会多一份读法,
      // 而且 Scan 出来的是**全部项目**的计划 ⇒ 提示条会把别的项目的条数算进来。
      const { listPlans } = await import("@/lib/backfill/service");
      return (await listPlans(opts.projectId)) as unknown as Array<Record<string, unknown>>;
    }
    const { listCodeTables } = await import("@/lib/modeling/service");
    return (await listCodeTables()) as unknown as Array<Record<string, unknown>>;
  }
  const out: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new ScanCommand({
        TableName: spec.table,
        ...countScanParams(kind, opts),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    out.push(...((res.Items ?? []) as Array<Record<string, unknown>>));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}
