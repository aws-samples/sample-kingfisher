// **建模落地的逐 target 物化 + drift 观测**(50 SPEC §3.8 轴A / INTERACTION §4ter)—— 唯一作者。
//
// ── 合同原文(§1.3 轴A)────────────────────────────────────────────────────────
// 码表 / 模型表:`regions?` → **`targets?: string[]`** 绑定;
// `landed:bool` → 🔴 **`landedByTarget: {[targetId]: {version, at, status, observedSchemaHash}}`**
// ——「**观测态**,非"我以为推了啥",防看板假绿」。这句话是本文件的全部设计压力。
//
// ── 为什么"观测"是硬要求,不是锦上添花 ────────────────────────────────────────
// 落地 DDL 是 `CREATE TABLE IF NOT EXISTS`。所以当该 target 上**已经存在一张同名但结构不同**的表时:
//   · 建表语句静默成功(什么都没做);
//   · 紧接着的 `DELETE` / `INSERT ("value","label","seq")` 才会因列不匹配而报错;
//   · 而报错文本是 Redshift 的列名错误 —— 离"那个区有一张别人建的同名表"这个根因极远。
// ⇒ 必须**先观测再动手**:结构不一致就判 `drift`、**不执行**、把字段级差异给出来
//   (INTERACTION §4ter:`drift` 绝不显示为 ✓,处置出口是〔查看差异〕+〔以平台定义强制重建 ⚠〕)。
//
// ── 🔴 "已落"不等于"现在还是那样" ────────────────────────────────────────────
// 落地记录里存的是**落地那一刻的观测**。库里的表随后被别人改了,平台是不知道的 ——
// 所以读侧只做两件**本地就能判**的事:① 定义变了 ⇒ `stale`;② 上次观测到的状态。
// 想知道"现在"是什么样,必须**重新观测**(`probeOnly`)。界面必须显示「观测于 <时间>」,
// 🔴 **不许把陈旧观测画成实时绿灯** —— 那正是"看板假绿"。
//
// 🔴 判态 / 列签名 / diff 这些**纯函数在 `landing-shared.ts`**(客户端组件也要用同一份判据)。

import { createHash } from "node:crypto";
import { ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand } from "@aws-sdk/client-redshift-data";
import {
  redshiftDataClientFor,
  resolveTargetWarehouse,
  describeSecretArnByName,
  execOnTarget,
  type TargetWarehouse,
} from "@/lib/exec-env/target-clients";
import {
  resolveRedshiftBinding,
  assertBindableTarget,
  type RedshiftBinding,
} from "@/lib/exec-env/data-plane-target";
import { requireReadyTarget } from "@/lib/exec-env/registry";
// 非 home 落地 / 清理的落点决策记账(观测输入,不是决策来源)
import { notePlaceDecision } from "@/lib/place/context";
import { awaitTerminal } from "@/lib/long-ops/await-terminal";
import { withSchemaCreateRetry } from "@/lib/redshift/concurrent-schema";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import type { AuthenticatedActor } from "@/lib/exec-env/admin-ddl-executor";
import type { AdminDdlRequest, ModelingObjectKind } from "@/lib/exec-env/admin-ddl-request";
import { columnSignature, normalizeTypeName, type LandedRecord } from "./landing-shared";
// 落点守卫(门②)+ 窄权写者 secret 名的唯一作者
import { assertPlatformGlobalSchema, sharedWriterSecretName } from "./landing-fqn";

// 服务端调用方从本文件一处拿全(不必记住哪些在 shared)
export * from "./landing-shared";

/** 定义哈希:同一份定义 ⇒ 同一个哈希。取 12 位十六进制(够区分,又短到能显示)。 */
export function defHashOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

// ══════════════════════════════════════════════════════════════════════════════
// 观测 / 执行(打 Redshift)
// ══════════════════════════════════════════════════════════════════════════════


/** 观测 / 执行需要的四样落点(home = 现网绑定;非 home 观测 = 该区落点 + **窄权写者**的 secret)。 */
export type ExecPlace = Pick<RedshiftBinding, "region" | "workgroup" | "database" | "secretArn">;

/** 在某 target 上跑一条查询并取回结果行。 */
export async function queryOnTarget(b: ExecPlace, sql: string): Promise<string[][]> {
  const client = redshiftDataClientFor(b.region);
  const { Id } = await client.send(
    new ExecuteStatementCommand({
      Sql: sql,
      WorkgroupName: b.workgroup,
      Database: b.database,
      ...(b.secretArn ? { SecretArn: b.secretArn } : {}),
    })
  );
  // 等待外部终态只许经 awaitTerminal(没有长操作 / 后台等待者上下文即抛 —— 请求路径不许同步等终态;根治)。
  // 退避口径不变:150ms 起 ×1.6 上限 1s、60 轮(与 `execOnTarget` 同一条口径 —— 固定 1s 起步会撞 ALB 504)。
  return awaitTerminal<string[][]>({
    what: "观测语句",
    maxPolls: 60,
    probe: async () => {
      const d = await client.send(new DescribeStatementCommand({ Id }));
      if (d.Status === "FINISHED") {
        if (d.HasResultSet === false) return { done: true, value: [] };
        const r = await client.send(new GetStatementResultCommand({ Id }));
        return { done: true, value: (r.Records || []).map((row) => row.map((c) => String(Object.values(c)[0] ?? ""))) };
      }
      if (d.Status === "FAILED" || d.Status === "ABORTED") throw new Error(d.Error || `语句${d.Status}`);
      return { done: false, state: d.Status };
    },
  });
}

export async function execOnBinding(b: RedshiftBinding, statements: string[]): Promise<void> {
  const client = redshiftDataClientFor(b.region);
  for (const sql of statements) {
    // 🔴 `CREATE SCHEMA IF NOT EXISTS` 在 Redshift **不是原子的**
    //   (lib/redshift/concurrent-schema.ts):两个维度表同时落进同一个新 schema 会有一个撞
    //   `pg_namespace_nspname_index`。原来的加固写在 `modeling/redshift.ts` 的 `execStatements` 里,
    //   而那个函数**零生产调用方**(落地早已改走这里)⇒ 真正执行的这条路从来没有加固过。包装器只对
    //   「幂等 schema 创建 + 并发签名」重试,别的语句一次都不重试 ⇒ 语句本身逐字节不变。
    await withSchemaCreateRetry(sql, async () => {
      const { Id } = await client.send(
        new ExecuteStatementCommand({
          Sql: sql,
          WorkgroupName: b.workgroup,
          Database: b.database,
          ...(b.secretArn ? { SecretArn: b.secretArn } : {}),
        })
      );
      // 同上,80 轮
      await awaitTerminal<void>({
        what: "Redshift 语句执行",
        maxPolls: 80,
        probe: async () => {
          const d = await client.send(new DescribeStatementCommand({ Id }));
          if (d.Status === "FINISHED") return { done: true, value: undefined };
          if (d.Status === "FAILED" || d.Status === "ABORTED") throw new Error(d.Error || `语句${d.Status}`);
          return { done: false, state: d.Status };
        },
      });
    });
  }
}

/**
 * 观测某 target 上这张表的**真实列结构**。
 *
 * @returns `null` = 表不存在;否则规范化后的列签名
 */
export async function observeColumns(b: ExecPlace, schema: string, table: string): Promise<string | null> {
  // 🔴 参数走字面量拼接,但 schema/table 都是**平台侧生成并过 `safeIdent`** 的标识符
  // (码表名 `dim_code_<code>`、模型表名都经白名单),不是用户自由串。
  const sql =
    `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale ` +
    `FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ` +
    `ORDER BY ordinal_position`;
  const rows = await queryOnTarget(b, sql);
  if (rows.length === 0) return null;
  return columnSignature(
    rows.map((r) => ({
      name: r[0],
      type: normalizeTypeName(r[1], r[2] ? Number(r[2]) : null, r[3] ? Number(r[3]) : null, r[4] ? Number(r[4]) : null),
    }))
  );
}

export interface LandArgs {
  targets: string[];
  // 原 `projectId?` 已删:建模**没有项目维**(SPEC §3.9d.8),
  //   那个可选字段在所有生产调用点都是 undefined;留着只会诱导后人「补一个 projectId 让它过白名单」。
  /** 🔴 建模对象类型 + 台账 id:非 home 的 admin 模板只收 id、服务端读台账(成员资格守卫,§3.9d.7(a)) */
  kind: ModelingObjectKind;
  objectId: string;
  /**
   * 🔴 非 home 落地的行为主体(admin 通道要具名、可归因的 actor;路由传 `actorFromIdentity(identity)`)。
   * **必填**:`null` = 调用方显式声明「没有」⇒ 非 home 判 failed 并说清原因(不静默借系统身份)。
   */
  actor: AuthenticatedActor | null;
  schema: string;
  table: string;
  /** 平台定义期望的列签名(由各建模类型自己算) */
  expectedColumns: string;
  /** 落地语句(建表 + 灌数等)—— **home** 原样执行(逐字节不变) */
  statements: string[];
  /**
   * 🔴 数据层语句(码表 = `DELETE` + `INSERT … VALUES`;维度/事实表 = 空)。
   * 非 home **只有这一层**由窄权 shared_writer 执行;结构层走 admin 模板(§3.9a §4.6 两层拆分)。
   */
  writeStatements: string[];
  defHash: string;
  /** `true` = 只观测,不动库(界面的〔检测〕按钮) */
  probeOnly?: boolean;
  /**
   * 该定义**已有的**落地记录(逐 target)。
   *
   * 🔴 只观测(`probeOnly`)时**必须**沿用上一条记录的 `defHash` —— 见 `landOne` ① 分支的说明。
   * 不传等于"没有历史",观测出来的结构再对也只能判「版本不齐」(诚实:平台没落过这份定义)。
   */
  previous?: Record<string, LandedRecord | undefined> | null;
  /**
   * `true` = **以平台定义强制重建**(先 DROP 再建)。
   * 🔴 有损操作:调用方必须已经过二次确认(INTERACTION §4ter 机制A)。
   */
  force?: boolean;
}

/**
 * 逐 target 落地/观测。**每个 target 各自 try**,一个区失败不影响其它区
 * (与直查同一条纪律:建模落地也是"多个独立的异步动作",不是一个事务)。
 */
export async function landToTargets(args: LandArgs): Promise<Record<string, LandedRecord>> {
  const out: Record<string, LandedRecord> = {};
  const list = args.targets.length ? args.targets : [HOME_TARGET_ID];
  for (const targetId of list) {
    out[targetId] = await landOne(targetId, args);
  }
  return out;
}

async function landOne(targetId: string, args: LandArgs): Promise<LandedRecord> {
  const nowIso = new Date().toISOString();
  const qualified = `${args.schema}.${args.table}`;
  const base = { defHash: args.defHash, table: qualified, at: nowIso, expectedColumns: args.expectedColumns };
  try {
    // 原「非 home 一律判 `credential-gap`、一条语句都不执行」**已删**
    //   (那段 error 文本说「窄权通道至今未交付」,本批交付后它就是一句过期的话)。非 home 走独立分支:
    //   见 `landOneNonHome`。跨法域与同法域**同一条路**(DESIGN §18 决策 6quinquies,不设法务门)。
    if (!isHome(targetId)) return await landOneNonHome(targetId, args, base, nowIso);
    // ── home:现网那条路,逐字节不变(admin 绑定 + 原样执行 `statements`)──────────────────
    const b = await resolveRedshiftBinding({ targetId });
    const observed = await observeColumns(b, args.schema, args.table);

    // ① 只观测(界面〔检测〕):把"现在"的事实记下来,不动库
    //
    // 🔴🔴 **观测**绝不许盖上「当前定义指纹」—— 它只看得见**列结构**,看不见数据。
    // 码表最常见的改法就是**加一个枚举值**:列结构一个字没变、表里少一行。
    // 若这里写 `defHash = 当前指纹`,那么点一下〔重新检测〕就能把 ⚠版本不齐 变成 ✓已落,
    // 而那个区的表里其实缺那一行 —— 这正是合同点名要防的假绿(观测态被当成"我以为推了啥")。
    // ⇒ 指纹**沿用上一条记录**;没有历史就写空串(读侧判「版本不齐」,提示去真落一次)。
    const keepHash = args.previous?.[targetId]?.defHash ?? "";
    if (args.probeOnly) {
      const pbase = { ...base, defHash: keepHash };
      if (observed === null) return { ...pbase, status: "failed", error: "该 target 上不存在这张表", observedAt: nowIso };
      return observed === args.expectedColumns
        ? { ...pbase, status: "ok", observedAt: nowIso, observedColumns: observed }
        : { ...pbase, status: "drift", observedAt: nowIso, observedColumns: observed };
    }

    // ② 🔴 **先观测再动手**:已存在且结构不同 ⇒ 判 drift 并**不执行**
    //    (DDL 是 `CREATE TABLE IF NOT EXISTS`,硬跑下去只会在灌数那步报一个离根因很远的列名错)
    if (observed !== null && observed !== args.expectedColumns && !args.force) {
      return { ...base, status: "drift", observedAt: nowIso, observedColumns: observed };
    }

    const stmts =
      args.force && observed !== null && observed !== args.expectedColumns
        ? // 🔴 强制重建:DROP 是**有损**的,调用方必须已经二次确认过(见 LandArgs.force)
          [`DROP TABLE IF EXISTS ${qualified}`, ...args.statements]
        : args.statements;
    await execOnBinding(b, stmts);

    // ③ 落地后**再观测一次**:这才是"观测态"。不再观测就等于"我以为推上去了"(合同点名要防的)
    const after = await observeColumns(b, args.schema, args.table);
    if (after === null) {
      return { ...base, status: "failed", error: "落地语句执行完毕,但观测不到这张表", observedAt: new Date().toISOString() };
    }
    return after === args.expectedColumns
      ? { ...base, status: "ok", observedAt: new Date().toISOString(), observedColumns: after }
      : { ...base, status: "drift", observedAt: new Date().toISOString(), observedColumns: after };
  } catch (e) {
    return { ...base, status: "failed", error: String((e as Error)?.message ?? e).slice(0, 900), observedAt: nowIso };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 非 home 的建模落地(50 SPEC §3.9d;关闭第五态「⊘ 缺写入通道」)
// ══════════════════════════════════════════════════════════════════════════════
//
// 四道门全过才放行(§3.9d.8),绝不 fail-open:
//   ① 准入:`assertBindableTarget(…, {scope:"platform-global"})` —— 存在 / ready / 装了 redshift / 跨法域技术前置;
//      🔴 **只跳过**项目白名单(建模没有项目维,白名单对它是 dead-closed,台账);
//   ② 落点:`assertPlatformGlobalSchema` —— 不许落进任何 `proj_<…>`;
//   ③ 成员资格:admin 执行器第 2 步按 id 读码表 / 模型表台账,查不到即拒;
//   ④ 可审计:`modeling-land` 区域审计(调用方在落地前写)+ admin 执行器自己的意图 / 结果审计。
//
// 两层拆分(§3.9a §4.6):结构 + 权限走 admin 模板(`land-code-table` + `grant-shared-writer` /
// `land-model-table`);**只有数据层**用窄权写者的 secret 直调 `execOnTarget`(DML 不许进 admin 模板)。
//
// 🔴 观测为什么放在 admin 建表 + 授权**之后**:`information_schema.columns` 只列出**当前用户有权**的表,
//    而观测用的是窄权写者(admin 凭证只活在执行器里,不出函数)。授权之前它看不见任何表 ⇒ 先观测会把
//    「那个区已有一张结构不同的同名表」误判成「不存在」。所以序是:建表(IF NOT EXISTS,已存在则无操作)
//    → 授权 → 观测(结构不同 ⇒ drift,**不灌数**)→ 灌数 → 再观测。

/**
 * 解绑 / 行数预览两处共用的分流口:home ⇒ 现网绑定(逐字节不变);非 home ⇒ `null`(走窄权通道)。
 * 🔴 收成一处:主控区分支是落点棘轮 L2 计数的对象,不许每个函数各写一遍。
 */
async function homeBindingOrNull(targetId: string): Promise<RedshiftBinding | null> {
  return isHome(targetId) ? resolveRedshiftBinding({ targetId }) : null;
}

/** 窄权写者的观测 / 执行落点:该区的 workgroup / database + 窄权 secret。 */
function writerPlace(wh: TargetWarehouse, secretArn: string): ExecPlace {
  return { region: wh.region, workgroup: wh.workgroup, database: wh.database, secretArn };
}

/** 认得出的「窄权写者凭证与库里对不上」信号(口令被并发轮换 / 库被重建后用户没了)。 */
function isWriterAuthFailure(e: unknown): boolean {
  return /password authentication failed|user "?shared_writer"? does not exist/i.test(String((e as Error)?.message ?? e));
}

/**
 * 取窄权写者 secret 的 ARN;**不存在就先供给**(`provisionSharedWriter`,幂等:用户已在 ⇒ 轮换口令)。
 * 🔴 按名现查,不读描述符(§3.9d.1:资源袋的唯一作者是部署期读 CFN Output)。
 */
async function ensureSharedWriter(actor: AuthenticatedActor, targetId: string, wh: TargetWarehouse): Promise<string> {
  const name = sharedWriterSecretName(targetId);
  const have = await describeSecretArnByName(wh.region, name);
  if (have) return have;
  const { provisionSharedWriter } = await import("@/lib/exec-env/admin-ddl-executor");
  await provisionSharedWriter(actor, { targetId });
  const arn = await describeSecretArnByName(wh.region, name);
  if (!arn) throw new Error(`窄权写者已供给,但按名 ${name} 在 ${wh.region} 查不到 secret ⇒ 拒绝继续(写得进去 ≠ 是对的)`);
  return arn;
}

/**
 * 用窄权写者跑一步;若库里拒的是**它的凭证本身**(口令被并发轮换覆盖 / 用户被删),
 * 轮换一次(重新供给)再试一次。🔴 只认这一类信号、只重试一次:其它错误原样抛(权限不足就是权限不足)。
 */
async function asWriter<T>(
  actor: AuthenticatedActor,
  targetId: string,
  wh: TargetWarehouse,
  arn: string,
  step: (place: ExecPlace) => Promise<T>
): Promise<T> {
  try {
    return await step(writerPlace(wh, arn));
  } catch (e) {
    if (!isWriterAuthFailure(e)) throw e;
    const { provisionSharedWriter } = await import("@/lib/exec-env/admin-ddl-executor");
    await provisionSharedWriter(actor, { targetId });
    const again = await describeSecretArnByName(wh.region, sharedWriterSecretName(targetId));
    if (!again) throw e;
    return await step(writerPlace(wh, again));
  }
}

/** 结构 + 权限两步 admin 模板(幂等,每次落地都跑:轮换口令 / 新码表 / 部分失败后补跑都是常态)。 */
function structureRequests(targetId: string, args: Pick<LandArgs, "kind" | "objectId">): AdminDdlRequest[] {
  return args.kind === "code-table"
    ? [
        { operation: "land-code-table", targetId, codeTableId: args.objectId },
        { operation: "grant-shared-writer", targetId, codeTableId: args.objectId },
      ]
    : [{ operation: "land-model-table", targetId, modelTableId: args.objectId }];
}

/**
 * 非 home 建模落地 / 清理的落点决策署名(观测清单按它归类)。与执行器的 `admin-ddl-executor` 分开:执行器只记它
 * 自己那一跳,而落地路径在进执行器之前就先打 Secrets Manager(窄权写者 secret 按名现查)与 Redshift Data(窄权观测)。
 */
export const LANDING_PLACE_VIA = "modeling-landing";

async function landOneNonHome(
  targetId: string,
  args: LandArgs,
  base: { defHash: string; table: string; at: string; expectedColumns: string },
  nowIso: string
): Promise<LandedRecord> {
  // 门①(准入;只跳过项目白名单)+ 门②(落点)
  await assertBindableTarget(targetId, "redshift", { scope: "platform-global" });
  assertPlatformGlobalSchema(args.schema);
  const wh = resolveTargetWarehouse(await requireReadyTarget(targetId));
  // 拿到该区仓位即记落点决策:下面窄权写者 secret 的按名现查
  //   与窄权观测都发生在进 admin 执行器(它自己记那笔)**之前**,没有这一笔它们在观测账本上无从归因
  //   (…7237 第四十三轮窗口 unattributedTop 仅剩的 1 类 = 本路径的 secretsmanager.DescribeSecret)。
  //   准入 / 落点被拒走不到这里 ⇒ 被拒的请求不会被归到某个区(与执行器同一条纪律)。
  notePlaceDecision({ targetId, via: LANDING_PLACE_VIA });
  const keepHash = args.previous?.[targetId]?.defHash ?? "";

  // ① 只观测:不动库(也不供给身份 —— 供给是写动作)
  if (args.probeOnly) {
    const pbase = { ...base, defHash: keepHash };
    const arn = await describeSecretArnByName(wh.region, sharedWriterSecretName(targetId));
    if (!arn) {
      return {
        ...pbase,
        status: "failed",
        observedAt: nowIso,
        error: "该区尚未供给 shared-writer 身份 ⇒ 无法观测;对这个区真落地一次即自动供给(观测不会替你建身份)",
      };
    }
    const observed = await observeColumns(writerPlace(wh, arn), args.schema, args.table);
    if (observed === null) return { ...pbase, status: "failed", error: "该 target 上不存在这张表(或窄权写者对它无权)", observedAt: nowIso };
    return observed === args.expectedColumns
      ? { ...pbase, status: "ok", observedAt: nowIso, observedColumns: observed }
      : { ...pbase, status: "drift", observedAt: nowIso, observedColumns: observed };
  }

  const actor = args.actor;
  if (!actor) {
    return {
      ...base,
      status: "failed",
      observedAt: nowIso,
      error: "非主控区的建模落地要经 admin 受控通道,必须带具名操作者(调用方未传 actor)⇒ 一条语句都没执行",
    };
  }
  const { executeAdminDdl } = await import("@/lib/exec-env/admin-ddl-executor");
  // ② 窄权写者身份(缺 secret 先供给)—— 必须在授权之前:GRANT 的对象得先存在
  const arn = await ensureSharedWriter(actor, targetId, wh);
  // ③ 结构 + 逐表授权(admin,幂等)
  const structure = async () => {
    for (const req of structureRequests(targetId, args)) await executeAdminDdl(actor, req);
  };
  await structure();
  // ④ 观测(授权之后才看得见;见上方说明)
  const observed = await asWriter(actor, targetId, wh, arn, (pl) => observeColumns(pl, args.schema, args.table));
  if (observed === null) {
    return {
      ...base,
      status: "failed",
      observedAt: new Date().toISOString(),
      error: "建表与授权已执行,但窄权写者观测不到这张表 ⇒ 不灌数(授权没生效时灌数只会换来一个离根因很远的权限错)",
    };
  }
  if (observed !== args.expectedColumns) {
    if (!args.force) return { ...base, status: "drift", observedAt: new Date().toISOString(), observedColumns: observed };
    // 🔴 强制重建:DROP 是**有损**的,调用方必须已经二次确认过(见 LandArgs.force);DROP 只有属主(admin)做得了
    await executeAdminDdl(actor, { operation: "drop-landed-table", targetId, kind: args.kind, objectId: args.objectId });
    await structure();
  }
  // ⑤ 数据层:**只有这一步**用窄权身份
  if (args.writeStatements.length) {
    await asWriter(actor, targetId, wh, arn, async (pl) => {
      for (const sql of args.writeStatements) {
        await execOnTarget({ warehouse: wh, sql, secretArn: pl.secretArn as string });
      }
    });
  }
  // ⑥ 落地后**再观测一次**(与 home 同一条纪律)
  const after = await asWriter(actor, targetId, wh, arn, (pl) => observeColumns(pl, args.schema, args.table));
  const at = new Date().toISOString();
  if (after === null) return { ...base, status: "failed", error: "落地语句执行完毕,但观测不到这张表", observedAt: at };
  return after === args.expectedColumns
    ? { ...base, status: "ok", observedAt: at, observedColumns: after }
    : { ...base, status: "drift", observedAt: at, observedColumns: after };
}

// ══════════════════════════════════════════════════════════════════════════════
// 解绑并清理:把某区的落地产物 DROP 掉(50 SPEC v3.20 §3.8)
// ══════════════════════════════════════════════════════════════════════════════

export interface UnlandResult {
  /** 是否真的执行了 DROP(表本来就不存在 ⇒ false,且**一条语句都不执行**) */
  dropped: boolean;
  /** DROP 前观测到的列签名(表不存在 ⇒ null) */
  observedBefore: string | null;
}

/**
 * 在某 target 上清理这张落地表。与落地**同一条执行通道**,不另开凭证路径:home = `resolveRedshiftBinding` +
 * `execOnBinding`;非 home = 窄权写者观测 + admin 模板 `drop-landed-table`。
 *
 * 🔴 三条:
 *  ① **先观测**:表不存在 ⇒ 不执行任何语句(连 `IF EXISTS` 也不跑 —— 零副作用,也不留「执行过 DROP」的审计噪声);
 *  ② `DROP TABLE IF EXISTS`:并发下别人先删了也不算失败;
 *  ③ **DROP 后再观测一次**,仍看得见 ⇒ 抛错。调用方(`unbind.ts`)靠这个抛错来保证「记录只在库里真没了之后才去掉」。
 */
export async function unlandFromTarget(
  targetId: string,
  args: { schema: string; table: string; kind: ModelingObjectKind; objectId: string; actor: AuthenticatedActor | null }
): Promise<UnlandResult> {
  const qualified = `${args.schema}.${args.table}`;
  const homeBinding = await homeBindingOrNull(targetId);
  if (homeBinding) {
    // ── home:现网那条路,逐字节不变 ──
    const b = homeBinding;
    const before = await observeColumns(b, args.schema, args.table);
    if (before === null) return { dropped: false, observedBefore: null };
    await execOnBinding(b, [`DROP TABLE IF EXISTS ${qualified}`]);
    const after = await observeColumns(b, args.schema, args.table);
    if (after !== null) {
      throw new Error(`DROP 已执行,但 ${targetId} 上仍观测到 ${qualified} —— 落地记录保留(记录必须对应库里的事实)`);
    }
    return { dropped: true, observedBefore: before };
  }
  // 非 home:原来这里同样走 `resolveRedshiftBinding`,而建模没有 projectId
  //   ⇒ 恒抛「必须带 projectId」(勘定实测;合同漏了这一处)。现在:观测用窄权写者、DROP 走 admin 模板
  //   `drop-landed-table`(窄权写者**刻意**没有 DROP 权,②)。
  assertPlatformGlobalSchema(args.schema);
  if (!args.actor) {
    throw new Error(`非主控区的清理要经 admin 受控通道,必须带具名操作者 —— ${targetId} 上的 ${qualified} 未清理,记录保留`);
  }
  const actor = args.actor;
  const wh = resolveTargetWarehouse(await requireReadyTarget(targetId));
  notePlaceDecision({ targetId, via: LANDING_PLACE_VIA }); // 与落地同一条纪律 —— 先记决策,再按名查 secret / 观测
  const arn = await describeSecretArnByName(wh.region, sharedWriterSecretName(targetId));
  if (!arn) {
    throw new Error(
      `${targetId} 尚未供给 shared-writer 身份 ⇒ 无法观测 ${qualified} 是否存在;为免「以为删了」不执行 DROP,记录保留`
    );
  }
  const before = await asWriter(actor, targetId, wh, arn, (pl) => observeColumns(pl, args.schema, args.table));
  if (before === null) return { dropped: false, observedBefore: null };
  const { executeAdminDdl } = await import("@/lib/exec-env/admin-ddl-executor");
  await executeAdminDdl(actor, { operation: "drop-landed-table", targetId, kind: args.kind, objectId: args.objectId });
  const after = await asWriter(actor, targetId, wh, arn, (pl) => observeColumns(pl, args.schema, args.table));
  if (after !== null) {
    throw new Error(`DROP 已执行,但 ${targetId} 上仍观测到 ${qualified} —— 落地记录保留(记录必须对应库里的事实)`);
  }
  return { dropped: true, observedBefore: before };
}

/**
 * 估算某区落地表的行数(影响预览用;`svv_table_info.tbl_rows` 是估值,界面标「约」)。
 * @returns `null` = 表不存在 / 查不到
 */
export async function estimateRows(targetId: string, args: { schema: string; table: string }): Promise<number | null> {
  const homeBinding = await homeBindingOrNull(targetId);
  if (!homeBinding) {
    // 非 home:原来同样恒抛「必须带 projectId」。改用窄权写者
    //   (它对每张平台落过的表都有 SELECT)数精确行数;`svv_table_info` 的可见性随权限变,不拿它赌。
    assertPlatformGlobalSchema(args.schema);
    const wh = resolveTargetWarehouse(await requireReadyTarget(targetId));
    // (2026-10-21,…7237 升级后 observe 实测):解绑预览走到这里的 DescribeSecret + ExecuteStatement / DescribeStatement /
    //   GetStatementResult 都没有落点决策 ⇒ unattributedTop 里 `…/unbind-preview` 一类 16 项。与落地 / 清理同一条纪律:拿到该区仓位就记决策。
    notePlaceDecision({ targetId, via: LANDING_PLACE_VIA });
    const arn = await describeSecretArnByName(wh.region, sharedWriterSecretName(targetId));
    if (!arn) return null;
    const rows = await queryOnTarget(writerPlace(wh, arn), `SELECT count(*) FROM "${args.schema}"."${args.table}"`);
    const n = Number(rows[0]?.[0]);
    return Number.isFinite(n) ? n : null;
  }
  const b = homeBinding;
  // schema / table 都是平台侧生成并过白名单的标识符(与 `observeColumns` 同一条说明)
  const rows = await queryOnTarget(
    b,
    `SELECT tbl_rows FROM svv_table_info WHERE "schema" = '${args.schema}' AND "table" = '${args.table}'`
  );
  if (rows.length === 0) return null;
  const n = Number(rows[0]?.[0]);
  return Number.isFinite(n) ? n : null;
}

/** 码表落地的期望列签名(与 `buildLandStatements` 的建表语句**同源**,不许各写一遍)。 */
export const CODE_TABLE_COLUMNS = columnSignature([
  { name: "value", type: "varchar(64)" },
  { name: "label", type: "varchar(256)" },
  { name: "seq", type: "integer" },
]);
