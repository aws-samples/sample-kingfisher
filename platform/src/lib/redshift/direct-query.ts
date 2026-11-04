// @kf-batch 50-WP2-directquery
// **数仓直查的单一作者**(50 SPEC §3.4;施工包 WORK-PACKAGES WP-2 ④ B 组)。
//
// ── 为什么必须有这个文件 ──────────────────────────────────────────────────────
// 收编之前,治理目录 / 质量 / 指标 / 建模 / 敏感扫描(+ 问数两处)各自持有:
//   ① 一个模块级 `new RedshiftDataClient({ region: process.env.AWS_REGION })`;
//   ② 一份「取 workgroup / database / secretArn」的落点逻辑;
//   ③ 一份**逐字复制**的轮询循环(50 次 × 700ms、同样的错误文案)。
// 七份副本 = 七处都要改才能支持按区执行,而漏改的那处**不会报错** —— 它会安安静静地
// 把「我在看 us-west-2」的查询打到主控区的数仓上,返回一份看起来很正常的结果。
// 这正是「非 home 静默取不到 / 写回 home」那类 bug 的模板(WP-2 ④ 原话)。
//
// ⇒ 本文件收口三件事:**落点解析** + **客户端** + **轮询**;并把「该区没装数仓」这件事
//    表达成一个**能力态**(`unavailable`)而不是异常,因为它是**正常的产品状态**:
//    某个执行环境可以只装数据湖(core-only),此时直查该降级、不该报错。
//
// ── 🔴 三条不许破的规矩 ────────────────────────────────────────────────────────
// ① **行形状不归本文件管**。`directQueryRaw` 回的是 SDK 原样的 `columns` + `records`,
//    单元格归一留给各领域自己(实测七个消费者的归一口径**并不相同** ——
//    质量把非数字字符串判成 `null`,指标原样返回字符串;统一了就是悄悄改行为)。
// ② **home 分支不许传 projectId**。治理 / 质量 / 指标 / 敏感扫描是**平台级只读**
//    (52 §3.9 的静态归类 `governance-read`),它们本来就没有项目;而 home 的
//    `getRedshiftSecretArn({project})` 会去查 per-project 凭证 ⇒ 在 P52.5a 交付之前
//    一律 fail-closed(那四个文件里都写着这句警告)。⇒ home 走**无 project** 的老路,
//    与改动前逐字节等价。
// ③ **非 home 必须带 projectId**:`resolveRedshiftBinding` 在非 home 上要 project-context
//    凭证(50 SPEC §3.9b),缺 projectId 它自己抛 `no-credential`。平台级页面把
//    **当前活跃项目头**交给它(与建模页按区过滤同一条口径)——那只满足凭证契约与审计,
//    真正拿到的仍是该 target 的 per-target admin(`degradedToLegacyAdmin`),
//    不是 per-project 身份;per-project 化归 WP-9。

// @kf-batch 50-WP31-place-first-class —— 观测模式的落点决策记账(只记录;必须在第一个 await 之前调,见 place/context.ts)
import { notePlaceDecision } from "@/lib/place/context";
import {
  ExecuteStatementCommand,
  DescribeStatementCommand,
  GetStatementResultCommand,
} from "@aws-sdk/client-redshift-data";
import { redshiftDataClientFor } from "@/lib/exec-env/target-clients";
import { resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import { TargetBindingRejected } from "@/lib/exec-env/target-region";
import { assertTargetId, isHome } from "@/lib/exec-env/target-id";

/**
 * 调用点给的范围。
 * @kf-batch 50-WP31-place-first-class —— 🔴 `targetId` **必填**(原来「缺省 = 主控区」⇒ 指标计算 / 治理 / 目录
 *   任何一处漏传就静默在主控区数仓上跑)。主控区也要点名 `HOME_TARGET_ID`。
 */
export interface DirectQueryScope {
  targetId: string;
  /**
   * 🔴 只在**非 home** 时被使用(见文件头规矩 ②③)。
   * @kf-batch 50-WP31-place-first-class —— **必填**(原来可选 ⇒ 非主控区漏传在编译期看不出来,到真环境才 500:
   *   AI 代码生成 / 敏感扫描 2026-10-03 实测)。主控区分支照旧丢掉它(规矩 ②)。
   */
  projectId: string | null;
  /**
   * 调用方显式指定的落点(SQL 编辑器 / 同步向导会带 `?workgroup=`)。
   * 🔴 **原样转给 `resolveRedshiftBinding`**,由它做「与该 target 描述符不一致就拒」的检查 ——
   * 那条检查存在的理由是:界面会把 workgroup 预填成主控区的值,若这里静默以描述符为准,
   * 用户看到的是自己填的、真跑的是另一个,正是本模块要消灭的「看起来正常」。
   */
  workgroupOverride?: string | null;
  databaseOverride?: string | null;
}

/** 解析出来的落点(四样齐全才可能执行)。 */
export interface DirectQueryPlace {
  targetId: string;
  region: string;
  workgroup: string;
  database: string;
  secretArn?: string;
  home: boolean;
}

/** 「该区没装数仓」——**能力态**,不是错误。 */
export interface DirectQueryUnavailable {
  capability: "unavailable";
  targetId: string;
  /** 缺的组件(目前只有 `redshift` 一种情形会降级) */
  missing: "redshift";
  /** 给页面直接显示的人话(DESIGN §337 文案) */
  reason: string;
}

// @kf-batch 50-PROD-B-seq33 ② —— 精简形态已取消(用户 2026-10-10):注册 / 部署 / 摘组件都不再产出「没有数仓」的环境,
//   本分支只剩**防御**(存量不完整的环境)⇒ 文案说清这是「不完整」而不是一种可选形态,出路是〔补齐缺失组件〕。
export const NO_WAREHOUSE_REASON =
  "该执行环境不完整:未部署数据仓库(redshift 组件),暂时只能查数据湖(Athena / S3 Tables)。" +
  "每个执行环境都必须装齐全部组件 —— 请在「执行环境」详情页点〔补齐缺失组件〕。";

/**
 * 解析落点。**唯一作者是 `resolveRedshiftBinding`** —— 本函数只决定「home 要不要把 projectId 递进去」。
 *
 * 🔴 home 分支刻意走同一个 `resolveRedshiftBinding`(而不是自己拼 `homeWorkgroup()` + env):
 * 拼一遍就又多了一份落点逻辑,而这个文件存在的全部理由就是消灭那些副本。
 * 等价性:home 分支里 `resolveWorkgroup(undefined) === homeWorkgroup()`、
 * `resolveDatabase(undefined) === process.env.REDSHIFT_DATABASE || "dev"`(命名 SSOT 里
 * `redshiftDatabase.home === "dev"`),`secretArn` = `getRedshiftSecretArn()`(不带 project)。
 */
export async function resolveDirectQueryPlace(scope: DirectQueryScope): Promise<DirectQueryPlace> {
  notePlaceDecision({ targetId: scope.targetId || null, via: "resolveDirectQueryPlace" });
  const targetId = assertTargetId(scope.targetId);
  const overrides = {
    ...(scope.workgroupOverride ? { workgroupOverride: scope.workgroupOverride } : {}),
    ...(scope.databaseOverride ? { databaseOverride: scope.databaseOverride } : {}),
  };
  const b = await resolveRedshiftBinding(
    isHome(targetId)
      ? { targetId, ...overrides } // 🔴 home:不传 projectId(规矩 ②)
      : { targetId, projectId: scope.projectId, ...overrides }
  );
  return {
    targetId: b.targetId,
    region: b.region,
    workgroup: b.workgroup,
    database: b.database,
    ...(b.secretArn ? { secretArn: b.secretArn } : {}),
    home: b.home,
  };
}

/**
 * 「该区没装数仓」⇒ 降级;其它拒因(不存在 / 无权 / 落点冲突 / 缺凭证)**照抛**。
 *
 * 🔴 只认 `missing-component` 一种:把 `invalid-target` / `project-not-allowed` 也降级成
 * 「未部署数据仓库」就是**用一句错的解释盖住真正的问题**,用户会去点「补充部署」而毫无用处。
 */
export function degradeIfNoWarehouse(e: unknown, targetId: string): DirectQueryUnavailable | null {
  if (e instanceof TargetBindingRejected && e.reason === "missing-component") {
    return { capability: "unavailable", targetId, missing: "redshift", reason: NO_WAREHOUSE_REASON };
  }
  return null;
}

/** `_meta.warehouse` 的形状(目录路由用;`data` 形状不变)。 */
export interface NoWarehouseMeta {
  targetId: string;
  missing: "redshift";
  reason: string;
}

/**
 * @kf-batch 50-E140b-catalog-no-warehouse
 * 「这个 target 没装数仓」⇒ 给一句**和直查那条路逐字相同**的说明;装了 / 没点名 target ⇒ `undefined`。
 *
 * 🔴 为什么要有它:目录现在主要走 OpenMetadata(用户 2026-09-10 拍板),那条路上**没有** `capability`
 * 字段 ⇒ 直查那条路的降级说明**走不到** ⇒ core-only 目标看到的是一张**不给原因的空目录**,
 * 用户会以为同步坏了或表被删了。而平台自己的规矩是「读不到就说读不到」。
 * 🔴 为什么放在这里而不是路由里:拒因文案必须**单一作者**(与 `degradeIfNoWarehouse` 共用
 * `NO_WAREHOUSE_REASON`)—— 两处各写一份措辞,用户就会看到「同一件事两种说法」。
 */
export function noWarehouseMeta(
  target: { targetId: string; components: string[] } | undefined
): NoWarehouseMeta | undefined {
  if (!target) return undefined; // 没点名单一 target(全部 / 多区对比)⇒ 不是「某个区没装」这件事
  if (target.components.includes("redshift")) return undefined;
  return { targetId: target.targetId, missing: "redshift", reason: NO_WAREHOUSE_REASON };
}

/**
 * 解析落点,并把「该区没装数仓」变成能力态。**一次请求解析一次、跑 N 条 SQL** ——
 * 与收编前的形态一致(那时是一个模块级客户端 + N 次 send),也省掉 N 次注册表强一致读。
 *
 * 🔴 两个分支都带 `capability`,构成**真正的判别联合** —— 少了它,消费者那边
 * `"reason" in x` 之类的写法在索引签名类型上会静默失效(实测:`ResultRow` 是
 * `Record<string, number|null>`,narrowing 形同没写)。
 */
export async function resolveDirectQueryPlaceSafe(
  scope: DirectQueryScope
): Promise<{ capability: "available"; place: DirectQueryPlace } | DirectQueryUnavailable> {
  const targetId = scope.targetId;
  try {
    return { capability: "available", place: await resolveDirectQueryPlace(scope) };
  } catch (e) {
    const down = degradeIfNoWarehouse(e, targetId);
    if (down) return down;
    throw e;
  }
}

/** 原样回 SDK 的列名与记录行(**不归一单元格** —— 见文件头规矩 ①)。 */
export interface DirectQueryRaw {
  columns: string[];
  records: Array<Array<unknown>>;
  /** SDK 的 `TotalNumRows`(问数要它当 rowCount;缺省 undefined,调用方自己回落成 records.length)。 */
  totalNumRows?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询预算的**缺省**值 = 收编前多数副本用的那一组(50 × 700ms ≈ 35s)。
 *  🔴 别顺手"优化":质量规则那条 SQL 在真环境要跑十几秒,改小了会把好查询判成超时。 */
const POLL_ROUNDS = 50;
const POLL_INTERVAL_MS = 700;

/**
 * 轮询预算。**允许调用点覆盖**,理由是收编前它们并不一致 ——
 * 实测敏感扫描用的是 **40 × 600ms**(≈24s),别的用 50 × 700ms(≈35s)。
 * 统一成一个值就是**悄悄改了「多久算超时」**:抽样 SQL 慢一点原本会超时的现在不超时(或反之),
 * 而这类变化在页面上表现为"扫描结果时多时少",极难归因。⇒ 让它显式、并在调用点写清原值。
 */
export interface DirectQueryPoll {
  rounds?: number;
  intervalMs?: number;
  /**
   * 🔴 **错误文案也允许调用点覆盖**,理由与轮询预算同源:收编前七处的文案并不一致
   * (「查询超时」/「抽样查询超时」/「schema introspection 超时」;失败时有的回
   * `desc.Error || 查询<状态>`,GenBI 回 `desc.Error || desc.Status || "schema introspection failed"`)。
   * 这些字符串**已经被页面、日志与 GenBI 的错误处理读过** —— 统一成一句就是一次静默的行为变更。
   * ⇒ 循环只留一份实现,文案由调用点带上;缺省 = 多数副本原来的说法。
   */
  failedMessage?: (status: string, engineError?: string) => string;
  timeoutMessage?: string;
}

/**
 * 在给定落点上跑一条 SQL,等到 `FINISHED` 后取回结果行。
 *
 * 🔴 错误文案与收编前**逐字一致**(`desc.Error || 查询<状态>` / 「查询超时」):
 * 这些字符串已经被页面与验收脚本断言过,换个说法就是一次静默的行为变更。
 */
export async function directQueryRaw(
  place: DirectQueryPlace,
  sql: string,
  poll?: DirectQueryPoll
): Promise<DirectQueryRaw> {
  const rounds = poll?.rounds ?? POLL_ROUNDS;
  const intervalMs = poll?.intervalMs ?? POLL_INTERVAL_MS;
  const failedMsg = poll?.failedMessage ?? ((status: string, err?: string) => err || `查询${status}`);
  const timeoutMsg = poll?.timeoutMessage ?? "查询超时";
  const client = redshiftDataClientFor(place.region);
  const { Id } = await client.send(
    new ExecuteStatementCommand({
      Sql: sql,
      WorkgroupName: place.workgroup,
      Database: place.database,
      ...(place.secretArn ? { SecretArn: place.secretArn } : {}),
    })
  );
  for (let i = 0; i < rounds; i++) {
    await sleep(intervalMs);
    const desc = await client.send(new DescribeStatementCommand({ Id }));
    if (desc.Status === "FINISHED") {
      const res = await client.send(new GetStatementResultCommand({ Id }));
      return {
        columns: (res.ColumnMetadata || []).map((c) => c.name || ""),
        records: (res.Records || []) as unknown as Array<Array<unknown>>,
        ...(typeof res.TotalNumRows === "number" ? { totalNumRows: res.TotalNumRows } : {}),
      };
    }
    if (desc.Status === "FAILED" || desc.Status === "ABORTED") {
      throw new Error(failedMsg(String(desc.Status), desc.Error));
    }
  }
  throw new Error(timeoutMsg);
}

/**
 * 一把梭:解析落点 → 跑 SQL。「该区没装数仓」回 `unavailable`,其它拒因照抛。
 *
 * 用法(五条直查 + 问数都走它):
 *
 *     const r = await directQuery({ targetId: scope, projectId }, sql);
 *     if (r.capability === "unavailable") return r;      // 路由透传,页面置灰
 *     r.columns / r.records                              // 各自归一
 */
export async function directQuery(
  scope: DirectQueryScope,
  sql: string
): Promise<(DirectQueryRaw & { capability: "available"; place: DirectQueryPlace }) | DirectQueryUnavailable> {
  const targetId = scope.targetId;
  let place: DirectQueryPlace;
  try {
    place = await resolveDirectQueryPlace(scope);
  } catch (e) {
    const down = degradeIfNoWarehouse(e, targetId);
    if (down) return down;
    throw e;
  }
  const raw = await directQueryRaw(place, sql);
  return { capability: "available", place, ...raw };
}
