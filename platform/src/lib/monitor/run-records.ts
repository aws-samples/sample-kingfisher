// @kf-batch 52-P52.2-W2a-run-stamp
// 模块 52 P52.2 + 模块 50 P50.1 —— `bgp-task-runs` 的**唯一写通道**(合同里说的"盖章封装")。
//
// 合同:52 SPEC §1(`bgp-task-runs` 加 `projectId`,与 50 同一批写入点一次改齐)
//      · 50 SPEC §1.2(加 `targetId`)· 50 SPEC §6 S10(**禁裸** `PutCommand/UpdateCommand`
//        打 task-runs,须走盖章封装)· 52 SPEC §1 读写同批上线。
//
// ── 现状实测(量具 = `node scripts/ast-task-runs-writes.mjs`,不用 grep 目测)──────────────
// TS 侧 **23 处写 / 12 文件**(9 建行 + 14 回写),另有 **4 处 MWAA 旁路的 Python 副本**
// (DAG 里的 `put_item`,由 TS 模板串生成)⇒ 合计 **27 处**。
// 🔴 这与三份文档**完全对齐,此前以为的"数字互相矛盾"是我把分母看错了**:
//   50 SPEC §5「13 建行 + 14 回写 = 27」的 13 建行 = 9 TS + 4 Python;
//   50 ROADMAP §1-B「13 写入点盖章」= 建行数(**只有建行需要盖章**,见下);
//   52 DESIGN §11.3「27 处」= 需要动的总处数。
//
// ── 为什么必须收成"一个"通道(三类真实故障,本文件逐一在结构上消掉)────────────────
// ① **漏盖章**:27 处各自拼 Item,少一处就有一批 run 不带 `projectId` ⇒ 项目视图凭空少数据。
//    ⇒ `putRunRecord` 的 `stamp` 是**必填参数**:新写入方在类型层就造不出无章的 run 行。
// ② **幽灵行**:`UpdateCommand` 在 DDB 里是 **upsert** —— taskId/runId 打错会凭空造出一条
//    只有键的 run(与 P52.1 修掉的 `schedule/enable` 盲 Update 同族;`fireDownstreamOnce`
//    原先的 `attribute_not_exists(downstreamFired)` 对**不存在的行恒真**,正是这个洞)。
//    ⇒ 本通道的回写一律 `attribute_exists(taskId)`,并把条件不满足**如实回报为 false**。
// ③ **保留字漏起别名**:`status`/`duration`/`error`/`metrics` 全是 DDB 保留字,漏一个别名
//    **整条写入失败**(`sync/[id]/start` 的注释记着这次真事故:status/finishedAt/logS3Key/metrics
//    被一起写没了)⇒ 本通道对 `set` 里的**每个** key 无条件起别名 `#k<i>`,这类 bug 不可能再犯。
//
// ── 刻意不做的两件事(功能守恒,别顺手改语义)────────────────────────────────────────
// · **建行不加 `attribute_not_exists` 条件**:`sync/[id]/start` 的 zero-etl 通道**刻意**用同一个
//   runId 反复 Put 来推进状态(Put = 整行替换)。加条件会当场弄坏它。整行替换会丢属性是**存量语义**,
//   本批不改(要改是独立一批,得连读侧一起验)。
// · **不写 `taskTargetKey`**:50 SPEC §1.2 的复合 `runId` + GSI `byTaskTarget` 属 P50.1 未完成部分,
//   GSI 现在**并不存在**。先写一个没人读的属性 = 记忆 `unwired-code-is-unverified` 那个坑
//   (格式没被任何真实读路径验证过,却看起来"已经做了")。
//   🔴 单一写通道的真正收益在这里:等 P50.1 做复合 runId 时,**写侧只改本文件一处**,
//   不必再回去动那 27 个站点(50 SPEC §6.6「一次改齐」)。

import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
// @kf-batch 50-W3f-T0-T3 —— 多区扇出的关联标识(T2 只透传;形态与属性名的单一作者在 run-group.ts)
import { RUN_GROUP_ATTR, isRunGroupId } from "./run-group";

/** 一条 run 的归属两维:项目空间(52)× 执行目标(50)。 */
export interface RunStamp {
  projectId: string;
  targetId: string;
}

/** 盖章属性名 —— 门禁与回填脚本共用同一份真值,不各写字符串。 */
export const RUN_STAMP_ATTRS = ["projectId", "targetId"] as const;

/** run 所属资源(同步任务 / 工作流 / ETL 作业 / 引擎作业)行上与归属相关的两个字段。 */
export interface RunOwner {
  projectId?: string | null;
  targetId?: string | null;
}

/**
 * 从 run 所属**资源行**推出这条 run 的归属。
 *
 * 🔴 **为什么取资源行、不取请求头**:run 归属于任务,任务的 `projectId` 才是权威。
 * 请求头可以与之不一致(换个 `x-bgp-project` 打同一个 taskId),那样盖出来的章会把别人的 run
 * 记到自己名下。P52.1 已经把 by-id 路由统一成"按**资源归属项目**判"(`guardResourceAccess`),
 * 盖章沿用同一条判据,前后端口径才不会分叉。
 *
 * 🔴 **两个缺省值各自的理由(都不是"随手兜底")**:
 * · `projectId` 缺省 `proj-default` —— 存量资源没有该属性,而"没有 projectId 的存量属默认工作区"
 *   是全平台既定口径(`guardResourceAccess` 同款,且 `projectFilter(默认)` 专门带
 *   `attribute_not_exists(projectId)` 让存量可见)。这里若改成抛错,存量任务会一跑就炸。
 * · `targetId` 缺省 `tgt_home` —— 在 P50.3 把资源绑到 target **之前**,平台只有一条执行路径:
 *   所有 run 都在 home 跑(实测 `tgt_usw2_a` 只装了组件、没有任何资源绑上去)。
 *   这与外部审核 P0-4 抓的 fail-open(`registry.getTarget(id) ?? homeTarget`)**不是一回事**:
 *   那处是"要了一个 target、给了另一个 target 的凭证"(跨区泄露);这里是"资源还没有 target 维,
 *   记下它实际跑的那个"。⇒ 一旦资源带上 `targetId`,本函数立刻跟着它走;
 *   而 P50.3 扇出到多 target 时,由扇出侧用 `explicitTargetId` 传"这次真跑在哪"。
 */
export function resolveRunStamp(owner: RunOwner | null | undefined, explicitTargetId?: string): RunStamp {
  return {
    projectId: owner?.projectId || DEFAULT_PROJECT_ID,
    targetId: explicitTargetId || owner?.targetId || HOME_TARGET_ID,
  };
}

/** 建行(9 处 TS + 4 处 Python 旁路)。`stamp` 必填 —— 无章的 run 行造不出来。 */
export async function putRunRecord(args: {
  taskId: string;
  runId: string;
  taskType: string;
  stamp: RunStamp;
  status?: string;
  startedAt?: string;
  triggeredBy?: string;
  // @kf-batch 50-W3f-T0-T3
  /**
   * 同一次多区扇出里各条 run 共享的关联标识(T2 只透传,不做父对象)。
   * 只能从这个一等参数进来(`extra` 里混进来会被拒),形态由 `run-group.ts` 校验;
   * 单区运行传 `undefined` ⇒ 行上**没有**这个属性。
   */
  runGroupId?: string;
  /** 其余业务字段(glueJobName / airflowDagId / metrics / logs …)。 */
  extra?: Record<string, unknown>;
}): Promise<void> {
  const { taskId, runId, taskType, stamp, extra, runGroupId } = args;
  assertStampable(extra, "putRunRecord.extra");
  if (runGroupId !== undefined && !isRunGroupId(runGroupId)) {
    throw new Error(`putRunRecord.runGroupId 形态非法:${JSON.stringify(runGroupId)}(只接受 runGroupIdFor() 产出的 rg_<ulid>)`);
  }
  await docClient.send(
    new PutCommand({
      TableName: TABLES.TASK_RUNS,
      Item: {
        taskId,
        runId,
        taskType,
        status: args.status ?? "running",
        startedAt: args.startedAt ?? new Date().toISOString(),
        triggeredBy: args.triggeredBy ?? "manual",
        projectId: stamp.projectId,
        targetId: stamp.targetId,
        ...(runGroupId ? { [RUN_GROUP_ATTR]: runGroupId } : {}),
        ...extra,
      },
    })
  );
}

/**
 * 回写(14 处)。返回 `true` = 真改到了那一行;`false` = 行不存在(条件不满足),**没有造出幽灵行**。
 *
 * `stamp` 可选:给了就用 `if_not_exists` 补章 —— 只补空缺、**绝不覆盖**已有的章
 * (14 个回写点各自算一次 projectId 就有 14 次算错的机会;`if_not_exists` 让"算错"至多等于"没补")。
 */
/**
 * 「用户取消」的那个终态(`run-cancel.settleStopped` 写的值;子 stopped ⇒ 组 cancelled)。
 * 🔴 单一真值源:下面那条「不许改写取消结果」的不变量与它同源,不许各写一遍字面量。
 */
export const CANCELLED_RUN_STATUS = "stopped";

export async function updateRunRecord(args: {
  taskId: string;
  runId: string;
  /** 要写的字段;值为 `undefined` 的键自动跳过(调用方不必自己拼可选段)。 */
  set: Record<string, unknown>;
  stamp?: RunStamp;
  /** 额外条件(与 `attribute_exists(taskId)` 以 AND 串联),如 `attribute_not_exists(downstreamFired)`。 */
  extraCondition?: string;
  extraConditionValues?: Record<string, unknown>;
}): Promise<boolean> {
  const { taskId, runId, set, stamp, extraCondition } = args;
  assertStampable(set, "updateRunRecord.set");

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  let i = 0;
  let statusAlias: string | undefined;
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    if (k === "status") statusAlias = `#k${i}`;
    // 🔴 无条件起别名:status/duration/error/metrics/result… 都是 DDB 保留字,
    //    "只给我知道的那几个起别名"正是历史上漏掉一个就整条写失败的写法。
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`#k${i} = :v${i}`);
    i++;
  }
  if (stamp) {
    names["#sp"] = "projectId";
    names["#st"] = "targetId";
    values[":sp"] = stamp.projectId;
    values[":st"] = stamp.targetId;
    sets.push("#sp = if_not_exists(#sp, :sp)", "#st = if_not_exists(#st, :st)");
  }
  if (!sets.length) return false; // 无字段可写:不发空 Update(DDB 会报错)

  // @kf-batch 50-WP18b-fanout-seam(顺带:取消不许被自动化改写)
  // 🔴🔴 **用户取消是人的意图,不许被任何自动化写回覆盖。**
  //   2026-09-16 段 o2 的 E-163-2 实测形态:组取消 ⇒ `run-cancel` 把两条 run 写成 `stopped`(对),
  //   而 ETL 的**读时对账**与**进程内轮询**紧接着看到 `describe-statement` 说这条语句
  //   `ABORTED` / 查不到 ⇒ 把同一行改写成 `failed`。于是页面上「我自己按的取消」显示成**失败**,
  //   组派生状态也从 `cancelled` 变成 `failed`(词表:子 stopped ⇒ 组 cancelled;子 failed ⇒ 组 failed)。
  //   写它的作者有三个(cancel / 对账 / 轮询),挨个去改必然漏 —— 所以把不变量立在**唯一写通道**上:
  //   写 status 时若行上已经是 `stopped`,除非写的还是 `stopped`,一律条件不满足 ⇒ 不写(返回 false)。
  //   ⚠️ 只挡「已取消」这一个终态:别的终态之间的纠正(对账把假 running 收口)仍然允许。
  const nextStatus = typeof set.status === "string" ? set.status : undefined;
  // 🔴 复用 SET 段里 status 已有的那个别名:同一个属性名再起第二个别名毫无必要,
  //    而「两个别名指同一属性」正是这类表达式最容易被后人改错的地方。
  const guardStopped = nextStatus !== undefined && nextStatus !== CANCELLED_RUN_STATUS && !!statusAlias;
  if (guardStopped) values[":gstopped"] = CANCELLED_RUN_STATUS;
  const conds = [
    "attribute_exists(taskId)",
    ...(guardStopped ? [`(attribute_not_exists(${statusAlias}) OR ${statusAlias} <> :gstopped)`] : []),
    ...(extraCondition ? [`(${extraCondition})`] : []),
  ];
  const condition = conds.join(" AND ");

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.TASK_RUNS,
        Key: { taskId, runId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ...values, ...(args.extraConditionValues ?? {}) },
      })
    );
    return true;
  } catch (e: unknown) {
    // 条件不满足 = 行不存在(或额外条件未过)。这是**正常分支**,不是错误:
    // 它恰好就是本通道要的效果 —— 宁可不写,也不凭空造行。其余异常照常上抛。
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/**
 * 把某任务**所有仍 running 的 run** 收口成终态(5 处站点原本各抄一份这个循环)。
 *
 * 🔴 顺带修掉存量的两个毛病:① 原先 5 处的 `Query` **都没有翻页**(单任务 run 多到超 1MB
 * 就漏收口,留下永久 running 污染监控"运行中"计数);② 原先没有条件写(见 ② 幽灵行)。
 */
// @kf-batch 50-WP5-rungroup
/**
 * 按 taskId 读**全部** run 行(自动翻页)。
 *
 * 🔴 抽成单一作者的理由:这段翻页循环原来只存在于 `settleRunningRuns` 里,
 * 而 O2 的组读取也要按 taskId 取子 run —— 复制一份就等于把「不翻页会静默漏数」
 * 这个坑复制一份(本仓 §1.2 的 Scan→Query 整改同一个理由)。
 *
 * 🔴 **读失败一律抛**,绝不回空数组:「读不到」与「没有」是两个不同的事实,
 * 合成一个值时上层判据一定会说谎(记忆 verify-script-quality-lesson 的那条铁律)。
 */
export async function listRunsByTask(taskId: string, opts: { maxPages?: number } = {}): Promise<Record<string, unknown>[]> {
  const maxPages = opts.maxPages ?? 50;
  const rows: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLES.TASK_RUNS,
        KeyConditionExpression: "taskId = :t",
        ExpressionAttributeValues: { ":t": taskId },
        ExclusiveStartKey: startKey as never,
      })
    );
    rows.push(...((res.Items ?? []) as Record<string, unknown>[]));
    startKey = res.LastEvaluatedKey as never;
    if (!startKey) break;
  }
  return rows;
}

export async function settleRunningRuns(args: {
  taskId: string;
  status: string;
  set?: Record<string, unknown>;
  stamp?: RunStamp;
  maxPages?: number;
}): Promise<number> {
  const { taskId, status, set, stamp } = args;
  const running = (await listRunsByTask(taskId, { maxPages: args.maxPages }))
    .filter((r) => r.status === "running")
    .map((r) => String(r.runId));
  const done = await Promise.all(
    running.map((runId) => updateRunRecord({ taskId, runId, set: { status, ...(set ?? {}) }, stamp }))
  );
  return done.filter(Boolean).length;
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 MWAA 旁路(Python 侧)—— 盖章的**第二条真路径**,不能只修 TS
//
// 4 处 `put_item(Item=…)` 在 MWAA 里执行,拿不到本文件的函数;它们的章只能在
// **DAG 生成时**注入。若只改 TS 侧,调度触发的 run 依旧无章 ——
// 这就是 memory `bug-fix-dual-track-cookbook` 那条教训:只改执行侧挡不住生成侧。
// ⇒ 生成侧的字面量由**本文件**唯一产出,属性名与 TS 侧同源(parity 单测钉死)。
// ══════════════════════════════════════════════════════════════════════════════

/** 章的取值必须是"平白的标识符":不含引号/反斜杠/换行 —— 否则拼进 Python 就是注入面。 */
const SAFE_STAMP_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * 产出注入到生成式 Python dict 里的盖章片段,形如 `"projectId": "proj-x", "targetId": "tgt_home"`。
 *
 * 🔴 **fail-closed**:值不合法就抛,绝不"清洗后继续" —— 生成一个悄悄少了章、或被注入了别的
 * Python 表达式的 DAG,比发布失败危险得多(DAG 一旦上了 MWAA 就按 cron 一直跑)。
 */
export function pythonStampFields(stamp: RunStamp): string {
  for (const [k, v] of Object.entries(stamp)) {
    if (!SAFE_STAMP_VALUE.test(String(v))) {
      throw new Error(`盖章值非法,拒绝生成 DAG:${k}=${JSON.stringify(v)}(须匹配 ${SAFE_STAMP_VALUE.source})`);
    }
  }
  return `"projectId": ${JSON.stringify(stamp.projectId)}, "targetId": ${JSON.stringify(stamp.targetId)}`;
}

/**
 * 盖章字段**不许**从自由字段里混进来 —— 否则调用方能绕过 `stamp` 写一个别的项目号,
 * 单一写通道就白设了(这与 admin-DDL 的"类型层不给自由 SQL 的口子"是同一手法)。
 */
function assertStampable(obj: Record<string, unknown> | undefined, where: string): void {
  if (!obj) return;
  for (const k of RUN_STAMP_ATTRS) {
    if (k in obj) {
      throw new Error(`${where} 不许直接携带归属字段 ${k};归属只能经 stamp 参数落地(52 SPEC §1)`);
    }
  }
  // @kf-batch 50-W3f-T0-T3 —— 关联标识同理:只能经 `runGroupId` 一等参数进来(建行时定,回写不可改)。
  if (RUN_GROUP_ATTR in obj) {
    throw new Error(`${where} 不许直接携带 ${RUN_GROUP_ATTR};它只能经 putRunRecord 的 runGroupId 参数落地`);
  }
}
