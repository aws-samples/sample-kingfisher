// O2 —— RunGroup(多区联动运行的**持久父对象**)的**唯一写通道 + 唯一派生口径**。
//
// 合同:50 SPEC v3.44 **§1.3a S7**(表)· **§2.7**(四个端点)· **§3.17**(派生 + 定时确定性键)。
// 验收:ACCEPTANCE v1.52 段 `o2`(..)。
//
// ── 为什么必须收成「一个」通道(与 run-records.ts 同一手法)────────────────────────
// ① **状态不许有第二个真值源**:组状态永远由子 run 行派生(`deriveGroupStatus`),
//    表里的 `status` 只是**物化投影**。谁直接写 `status` 就等于造了第二真值源,
//    从此「页面说部分成功、表里说失败」这类事故无法排查。
// ② **组行写失败必须让运行失败**:放行的后果是那批 run **永远归不了组**
//    run 行是只追加的历史事实,事后补不回来(掉头成本的门在数据不在代码)。
// ③ **按 target 的一等写入必须幂等**:`accepted` / `skipped` 存成**以 targetId 为键的 map**,
//    而不是 list。`list_append` 天生会重复追加 ⇒ 一次重试就让组页面把同一个区显示两遍。
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { isResourceType } from "@/lib/versions/version-service";
// 🔴 从**轻量层** target-region 取(不是 data-plane-target —— 后者会把一堆 AWS 客户端拖进来;
//    `instrumentation` 可达面碰上 node 内置就构建失败,记忆 instrumentation-edge-bundle-boundary)
import { regionOfTarget } from "@/lib/exec-env/target-region";
import {
  isRunGroupId,
  RUN_GROUPS_GSI_BY_DEFINITION,
  type RunGroupDefinitionKind,
  type RunGroupStatus,
} from "./run-group";
import { listRunsByTask } from "./run-records";

// ── 子 run 状态词表(单一作者;引擎侧 `mapEmrState` / 两套 Python 执行体写的就是这几个值) ──
/**
 * 在途(还会自己变):
 *   · `running` —— 后端在跑,持有者(平台轮询器 / 调度器任务)在看着;
 *   · `timeout-pending` —— 2026-11-04显式收进词表:MWAA Serverless 单 task 50 分钟软限已到,调度器**放手了但后端可能仍在跑**
 *     (`job-exec-py._check_soft_limit` 写它,同时带上后端句柄 glueJobRunId / statementId / nativeRunId),由平台读时对账
 *     (`reconcileEtlJob` / EMR `reconcile`)按后端真实终态收口。它**不是终态**:当终态会把「不知道死活」说成结束;当 running 又会让人等一个不再续租的持有者。
 */
export const RUN_INFLIGHT_STATUSES = ["running", "timeout-pending"] as const;
/** 终态(不会再自己变了)。 */
export const RUN_TERMINAL_STATUSES = ["succeeded", "failed", "stopped"] as const;
/** 本模块**消费**的全部子 run 状态 = 在途 ∪ 终态。 */
export const RUN_CHILD_STATUSES = [...RUN_INFLIGHT_STATUSES, ...RUN_TERMINAL_STATUSES] as const;
export type RunChildStatus = (typeof RUN_CHILD_STATUSES)[number];

/**
 * 2026-11-04 —— 「一条 run 结束了没有」的唯一判据(删作业前核在途运行、读时对账要不要再去问后端,都用它)。
 * 🔴 fail-closed:只有写着终态词的 run 才算结束;`running` / `timeout-pending` / 词表外的值 / 缺失 都算**仍在途**
 *   —— 没有终态结论就不许当成「已结束」(纪律 9:状态只许来自真正的结论)。
 */
export function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === "string" && (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type RunGroupFailurePolicy = "continue" | "fail-fast-submit";

export interface RunGroupRow {
  runGroupId: string;
  definitionKind: RunGroupDefinitionKind;
  definitionId: string;
  projectId: string;
  requestedTargets: string[];
  /** 🔴 map 而非 list:按 target 写入必须幂等(见文件头 ③)。 */
  accepted: Record<string, { runId?: string; definitionVersion?: number }>;
  skipped: Record<string, { reason: string }>;
  failurePolicy: RunGroupFailurePolicy;
  status: RunGroupStatus;
  triggeredBy: string;
  createdAt: string;
  finishedAt?: string;
  retryOfRunGroupId?: string;
}

export interface RunGroupChild {
  targetId: string;
  /**
   * 该 target 的 region。
   * 🔴 解析不到就是 `null`(**不是把这一行藏起来**):执行环境被删掉之后,它的历史运行**仍然要看得见**
   *    —— 与会话卡片 GC-16「标题读不到也照样列出」同一条纪律(藏起来 = 用户以为记录丢了)。
   */
  region: string | null;
  runId: string;
  /** 原样带出来,**不做归一** —— 归一发生在 `deriveGroupStatus` 里且不认识的值会被报出来。 */
  status: string;
  taskType: string;
  startedAt?: string;
  finishedAt?: string;
  definitionVersion?: number;
  error?: string;
  /** 后端原生标识(取消要用;**不进 API 响应**,由路由投影掉)。 */
  statementId?: string;
  glueJobName?: string;
  glueJobRunId?: string;
  nativeRunId?: string;
}

/** 组行写失败 —— 运行路由必须把它当「拒绝这次运行」,不许 fail-open。 */
export class RunGroupWriteFailed extends Error {
  constructor(readonly op: string, readonly cause: unknown) {
    super(
      `运行分组台账写入失败(${op}):${cause instanceof Error ? cause.message : String(cause)}。` +
        `本次运行已拒绝 —— 若放行,这批运行记录将永远归不到一个组里,事后补不回来。`
    );
    this.name = "RunGroupWriteFailed";
  }
}

export class RunGroupInputInvalid extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RunGroupInputInvalid";
  }
}

// ─────────────────────────── 派生(纯函数,唯一口径)───────────────────────────

export interface DerivedGroupStatus {
  status: RunGroupStatus;
  /**
   * 出现过、但本模块**不认识**的子 run 状态原值。
   * 🔴 不认识的状态**当作未终态**(⇒ 组停在 `running`)并**如实报出来**:
   *    这是唯一安全的方向 —— 反过来把它当成终态就会出现「组说全部成功,其实有一条没人知道死活」。
   *    也绝不静默:平台哪天新增一个 run 状态而没人更新这里,必须能被看见
   *    (「有静默合法默认值的参数 = 一整类缺陷的温床」)。
   */
  unknownStatuses: string[];
}

export function classifyChildStatus(raw: unknown): RunChildStatus | null {
  return typeof raw === "string" && (RUN_CHILD_STATUSES as readonly string[]).includes(raw)
    ? (raw as RunChildStatus)
    : null;
}

/**
 * 组状态 = 子 run 行的函数(50 SPEC §3.17.1 的穷举)。
 *
 * 🔴 两对刻意**不合并**的态:
 * · `partial-failed` ≠ `failed` —— 折成 failed 会让用户不去看已经成功那个区的产物;
 * · `cancelled` ≠ `failed` —— 取消是用户的动作、失败是系统的结果,合并了「一键取消」就没法验成功。
 */
export function deriveGroupStatus(children: readonly { status: unknown }[]): DerivedGroupStatus {
  const unknown = new Set<string>();
  let running = 0;
  let succeeded = 0;
  let failed = 0;
  let stopped = 0;
  for (const c of children) {
    const st = classifyChildStatus(c.status);
    if (st === null) {
      unknown.add(String(c.status));
      running++; // 不认识 ⇒ 按「还没终态」算(见 DerivedGroupStatus.unknownStatuses)
      continue;
    }
    if ((RUN_INFLIGHT_STATUSES as readonly string[]).includes(st)) running++; // running / timeout-pending 都还没终态
    else if (st === "succeeded") succeeded++;
    else if (st === "failed") failed++;
    else stopped++;
  }
  const unknownStatuses = Array.from(unknown).sort();
  if (children.length === 0) return { status: "submitting", unknownStatuses };
  if (running > 0) return { status: "running", unknownStatuses };
  if (failed > 0) return { status: succeeded > 0 ? "partial-failed" : "failed", unknownStatuses };
  if (stopped > 0) return { status: "cancelled", unknownStatuses };
  return { status: "succeeded", unknownStatuses };
}

/** 终态 = 不会再自己变了(取消 / 重试按钮的可用性、以及要不要写 `finishedAt` 都看它)。 */
export function isTerminalGroupStatus(s: RunGroupStatus): boolean {
  return s === "succeeded" || s === "partial-failed" || s === "failed" || s === "cancelled";
}

// ─────────────────────────── 写通道 ───────────────────────────

/**
 * 扇出循环**之前**建组行。
 *
 * · `runGroupId` 由调用方给(手动扇出 = `runGroupIdFor()` 的 `rg_<ULID>`;定时 = 确定性 `rgs_…`)。
 * · 🔴 **单区不建组**:少于 2 个 target 直接抛 —— 让「单区运行不成组」在结构上不可能违反,
 *   而不是靠调用方记得判。
 * · 🔴 **定时的确定性键会被 N 个区各自建一次** ⇒ 第二个及以后**是加入、不是错误**:
 *   条件写撞了就回 `created:false`(与 `ConditionalCheckFailed = 一个答案、不是故障` 同一条纪律)。
 */
export async function openRunGroup(args: {
  runGroupId: string;
  definitionKind: RunGroupDefinitionKind;
  definitionId: string;
  projectId: string;
  requestedTargets: readonly string[];
  failurePolicy?: RunGroupFailurePolicy;
  triggeredBy?: string;
  retryOfRunGroupId?: string;
}): Promise<{ created: boolean }> {
  const { runGroupId, definitionKind, definitionId, projectId } = args;
  if (!isRunGroupId(runGroupId)) {
    throw new RunGroupInputInvalid(`runGroupId 形态非法:${JSON.stringify(runGroupId)}(只接受 rg_<ULID> 或 rgs_<24hex>)`);
  }
  if (!isResourceType(definitionKind)) {
    throw new RunGroupInputInvalid(
      `definitionKind 非法:${JSON.stringify(definitionKind)} —— 值域是 ResourceType,不许另造资源词汇`
    );
  }
  if (!definitionId || !projectId) {
    throw new RunGroupInputInvalid("definitionId / projectId 必填(组行没有归属就无法按项目、按定义查回来)");
  }
  const requestedTargets = Array.from(new Set(args.requestedTargets));
  // 🔴 单区不建组—— **唯一例外 = 重试链**:只剩一个区失败时,新的一次运行仍要能回指原组
  //    (否则要的那条链断在这里)。重试本来就是上一次联动的延续。
  if (requestedTargets.length < 2 && !args.retryOfRunGroupId) {
    throw new RunGroupInputInvalid(
      `不足两个执行目标(${requestedTargets.length} 个)且不是重试 ⇒ 不建组。单区运行照旧一条 run、不带 runGroupId`
    );
  }
  const item: RunGroupRow = {
    runGroupId,
    definitionKind,
    definitionId,
    projectId,
    requestedTargets,
    accepted: {},
    skipped: {},
    failurePolicy: args.failurePolicy ?? "continue",
    status: "submitting",
    triggeredBy: args.triggeredBy ?? "manual",
    createdAt: new Date().toISOString(),
    ...(args.retryOfRunGroupId ? { retryOfRunGroupId: args.retryOfRunGroupId } : {}),
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.RUN_GROUPS,
        Item: item,
        ConditionExpression: "attribute_not_exists(runGroupId)",
      })
    );
    return { created: true };
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
      // 定时确定性键:另一个区已经建过这一行 ⇒ 加入它。这是**答案**不是故障,绝不重试、绝不报错。
      return { created: false };
    }
    throw new RunGroupWriteFailed("openRunGroup", e);
  }
}

async function patchTargetSlot(
  op: string,
  runGroupId: string,
  attr: "accepted" | "skipped",
  targetId: string,
  value: Record<string, unknown>
): Promise<void> {
  if (!targetId) throw new RunGroupInputInvalid(`${op}:targetId 为空 ⇒ 这一格没法按区归因,拒绝写`);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.RUN_GROUPS,
        Key: { runGroupId },
        // 🔴 `attribute_exists` 防幽灵行:UpdateItem 在 DDB 里是 upsert,键打错会凭空造出一行
        //    只有键的组(与 run-records 里 `fireDownstreamOnce` 那个洞同族)。
        ConditionExpression: "attribute_exists(runGroupId)",
        UpdateExpression: `SET #a.#t = :v`,
        ExpressionAttributeNames: { "#a": attr, "#t": targetId },
        ExpressionAttributeValues: { ":v": value },
      })
    );
  } catch (e) {
    throw new RunGroupWriteFailed(op, e);
  }
}

/** 某个 target 这次**接下来了**(已提交出一条 run)。同一个 target 重复调 = 覆盖同一格(幂等)。 */
export async function recordAccepted(
  runGroupId: string,
  targetId: string,
  o: { runId?: string; definitionVersion?: number } = {}
): Promise<void> {
  await patchTargetSlot("recordAccepted", runGroupId, "accepted", targetId, {
    ...(o.runId ? { runId: o.runId } : {}),
    ...(typeof o.definitionVersion === "number" ? { definitionVersion: o.definitionVersion } : {}),
  });
}

/** 某个 target 这次**没跑**(绑定被拒 / 缺组件 / 驻留未同意 / fail-fast 之后的跳过)。 */
export async function recordSkipped(runGroupId: string, targetId: string, reason: string): Promise<void> {
  if (!reason) throw new RunGroupInputInvalid("recordSkipped:reason 必填 —— 没有原因的跳过在页面上等于「凭空少了一个区」");
  await patchTargetSlot("recordSkipped", runGroupId, "skipped", targetId, { reason });
}

// ─────────────────────────── 读(派生 + 对账写回)───────────────────────────

export async function getRunGroupRow(runGroupId: string): Promise<RunGroupRow | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.RUN_GROUPS, Key: { runGroupId } })
  );
  return (Item as RunGroupRow | undefined) ?? null;
}

/**
 * 取一个组的子 run。
 * 🔴 走 `taskId` Query 再按 runGroupId 过滤(`bgp-task-runs` 上**没有** runGroupId 索引,
 *    SPEC §1.2 的 GSI 未完成部分)。单个任务级别的量,可接受;**不 Scan**。
 */
export async function listRunGroupChildren(row: RunGroupRow): Promise<RunGroupChild[]> {
  const rows = (await listRunsByTask(row.definitionId)).filter((r) => r.runGroupId === row.runGroupId);
  const regions = new Map<string, string | null>();
  for (const r of rows) {
    const t = String(r.targetId ?? "");
    if (!t || regions.has(t)) continue;
    // 🔴 best-effort:环境被删了也要能看见历史(解析失败 ⇒ null,不抛、不藏行)
    regions.set(t, await regionOfTargetSafe(t));
  }
  return rows.map((r) => {
    const targetId = String(r.targetId ?? "");
    // 🔴 `definitionVersion` **只有一个作者 = 组行的 `accepted[targetId]`**。
    //    第一版把它写在类型上却没有任何地方写值 ⇒ UI 那一列永远是「-」
    //    (记忆 `unwired-code-is-unverified`:写了 ≠ 接上了;是写判据时才发现的)。
    //    刻意**不**同时往 run 行上也写一份 —— 同一个事实两处写迟早各自漂移。
    const acceptedVersion = row.accepted?.[targetId]?.definitionVersion;
    return {
      targetId,
      region: regions.get(targetId) ?? null,
      runId: String(r.runId ?? ""),
      status: String(r.status ?? ""),
      taskType: String(r.taskType ?? ""),
      ...(r.startedAt ? { startedAt: String(r.startedAt) } : {}),
      ...(r.finishedAt ? { finishedAt: String(r.finishedAt) } : {}),
      ...(typeof acceptedVersion === "number" ? { definitionVersion: acceptedVersion } : {}),
      ...(r.error ? { error: String(r.error) } : {}),
      ...(r.statementId ? { statementId: String(r.statementId) } : {}),
      ...(r.glueJobName ? { glueJobName: String(r.glueJobName) } : {}),
      ...(r.glueJobRunId ? { glueJobRunId: String(r.glueJobRunId) } : {}),
      ...(r.nativeRunId ? { nativeRunId: String(r.nativeRunId) } : {}),
    };
  });
}

async function regionOfTargetSafe(targetId: string): Promise<string | null> {
  try {
    return await regionOfTarget(targetId);
  } catch {
    return null;
  }
}

/** 组视图给 API 用的**公开**子行形状(§2.7)—— 后端原生标识不外泄。 */
export function publicChild(c: RunGroupChild) {
  const { statementId, glueJobName, glueJobRunId, nativeRunId, ...rest } = c;
  void statementId; void glueJobName; void glueJobRunId; void nativeRunId;
  return rest;
}

export interface RunGroupView {
  group: RunGroupRow;
  children: RunGroupChild[];
  /** 🔴 **UI 只许显示这个值**,不是 `group.status`(后者是缓存)。 */
  derivedStatus: RunGroupStatus;
  unknownChildStatuses: string[];
}

/**
 * 读一个组:**先派生、再与表里的物化值对账**;不一致就以派生值为准并顺手写回。
 *
 * 🔴 对账写回失败**不影响本次读**(它只是缓存);但**绝不**反过来拿表里的值去改子 run。
 */
export async function getRunGroup(runGroupId: string): Promise<RunGroupView | null> {
  const group = await getRunGroupRow(runGroupId);
  if (!group) return null;
  const children = await listRunGroupChildren(group);
  const { status, unknownStatuses } = deriveGroupStatus(children);
  if (group.status !== status) {
    const finishedAt = isTerminalGroupStatus(status) ? new Date().toISOString() : undefined;
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.RUN_GROUPS,
          Key: { runGroupId },
          ConditionExpression: "attribute_exists(runGroupId)",
          UpdateExpression: finishedAt ? "SET #s = :s, finishedAt = if_not_exists(finishedAt, :f)" : "SET #s = :s",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: finishedAt ? { ":s": status, ":f": finishedAt } : { ":s": status },
        })
      );
      group.status = status;
    } catch {
      // 缓存写回失败:本次读仍然正确(返回派生值)。刻意不抛。
    }
  }
  return { group, children, derivedStatus: status, unknownChildStatuses: unknownStatuses };
}

/** 列表里的一行:组行 + **服务端派生**的状态(UI 不许显示表里的物化值)。 */
export interface RunGroupListItem extends RunGroupRow {
  derivedStatus: RunGroupStatus;
  childCount: number;
  unknownChildStatuses: string[];
}

/**
 * 「这个定义最近的几次联动运行」**带派生状态**。
 *
 * 🔴 为什么把派生也放进列表:UI 若在未展开时显示 `row.status`(物化投影),那就是**第二真值源**
 * 泄漏到界面上 —— 「页面说部分成功、表里说失败」这类事故正是这么来的(§3.17.1 第 2 条)。
 * 🔴 代价只有**一次** Query:同一个定义的所有组共享同一个 `taskId` ⇒ 一次 `listRunsByTask`
 * 就能给全部组派生(不是每组一次)。
 */
export async function listRunGroupViewsByDefinition(definitionId: string, limit = 20): Promise<RunGroupListItem[]> {
  const rows = await listRunGroupsByDefinition(definitionId, limit);
  if (rows.length === 0) return [];
  const runs = await listRunsByTask(definitionId);
  return rows.map((row) => {
    const kids = runs.filter((r) => r.runGroupId === row.runGroupId);
    const { status, unknownStatuses } = deriveGroupStatus(kids as Array<{ status: unknown }>);
    return { ...row, derivedStatus: status, childCount: kids.length, unknownChildStatuses: unknownStatuses };
  });
}

/** 「这个定义最近的几次联动运行」—— 走 GSI `byDefinition`,**不 Scan**。 */
export async function listRunGroupsByDefinition(definitionId: string, limit = 20): Promise<RunGroupRow[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLES.RUN_GROUPS,
      IndexName: RUN_GROUPS_GSI_BY_DEFINITION,
      KeyConditionExpression: "definitionId = :d",
      ExpressionAttributeValues: { ":d": definitionId },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (res.Items ?? []) as RunGroupRow[];
}

// ────────────── 扇出路由的两个接缝(单一作者:两条运行路由不许各写一份)──────────────

/**
 * 扇出循环**之前**建组行。`runGroupId === undefined`(单区)⇒ **什么都不做**。
 *
 * 🔴 **严格**:写不进去就抛 `RunGroupWriteFailed`,由路由映射成「本次运行未提交」。
 */
export async function openRunGroupIfFanout(args: {
  runGroupId: string | undefined;
  definitionKind: RunGroupDefinitionKind;
  definitionId: string;
  projectId: string;
  requestedTargets: readonly string[];
  failurePolicy?: RunGroupFailurePolicy;
  triggeredBy?: string;
  retryOfRunGroupId?: string;
}): Promise<void> {
  if (!args.runGroupId) return;
  await openRunGroup({ ...args, runGroupId: args.runGroupId });
}

/**
 * 逐 target 的结果记账。返回 `null` = 记上了;返回一句人话 = 没记上(供响应如实带出)。
 *
 * 🔴 **为什么这里是「尽力」而 `openRunGroupIfFanout` 是「严格」**:
 * 子 run 的**真值源是 run 行本身**(`listRunGroupChildren` 按 taskId + runGroupId 读),
 * `accepted` 只是注解 ⇒ 这一格没写上,组的状态派生**依然正确**,顶多少了 `definitionVersion` 这类注解。
 * 而组行本身没建成就完全不同:那批 run 从此**归不了组**,run 行是只追加的历史事实,事后补不回来。
 * 🔴 而且此刻 run **已经提交出去了** —— 为了记台账去让整个请求失败,等于「明明在跑却告诉用户没跑」。
 */
export async function noteFanoutResult(
  runGroupId: string | undefined,
  targetId: string,
  r: { runId?: string; definitionVersion?: number } | { reason: string }
): Promise<string | null> {
  if (!runGroupId) return null;
  try {
    if ("reason" in r) await recordSkipped(runGroupId, targetId, r.reason);
    else await recordAccepted(runGroupId, targetId, r);
    return null;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`[monitor/run-groups] 组台账记账失败(不影响已提交的运行):group=${runGroupId} target=${targetId} ${why}`);
    return `${targetId}:组台账未记上(${why})`;
  }
}

// ────────────── MWAA 旁路(Python 侧):组行的**第二条真路径** ──────────────
// 🔴 定时触发的 run 由 DAG 在 MWAA 里写台账,拿不到本文件的函数(与 run-records 的
//    `pythonStampFields` 完全同一种处境)⇒ Python 侧那段源码**只许本文件产出**,
//    属性名与 `openRunGroup` 的 item 同源;parity 单测钉两侧字面。

/** 组表名的单一出口 —— 别处一律引这个函数,不许再写 `TABLES.RUN_GROUPS`(门禁扫)。 */
export function runGroupsTableName(): string {
  return TABLES.RUN_GROUPS;
}

/**
 * 注入到生成式 DAG 里的「建组行(幂等)」。
 *
 * · 条件写 `attribute_not_exists(runGroupId)`:**N 个区各自建一次,第一个赢、其余是加入**
 *   (与 TS 侧 `openRunGroup` 逐条对应;`ConditionalCheckFailed` 是一个答案、不是故障)。
 * · 🔴 建不成(非条件冲突的真错)也**不让这次 run 失败** —— 与 TS 侧刻意相反,理由:
 *   Python 侧只有一个区在跑,组行可能已经由**另一个区**建好了;而 run 行本身带着 `runGroupId`,
 *   子 run 的真值源就在那里,组行是可以由下一个区补建的。真错会 print 到任务日志。
 */
export function pythonRunGroupOpenSource(): string {
  return `# --- 由 lib/monitor/run-groups.ts 唯一产出,请勿手改 ---
def _ensure_run_group(spec, run_group_id):
    g = spec.get("scheduledGroup") or {}
    if not run_group_id or not g:
        return
    ddb = boto3.resource("dynamodb", region_name=spec["ctrlRegion"])
    item = {
        "runGroupId": run_group_id,
        "definitionKind": g["definitionKind"],
        "definitionId": g["definitionId"],
        "projectId": g["projectId"],
        "requestedTargets": list(g["requestedTargets"]),
        "accepted": {},
        "skipped": {},
        "failurePolicy": "continue",
        "status": "submitting",
        "triggeredBy": "schedule",
        "createdAt": datetime.utcnow().isoformat() + "Z",
    }
    try:
        ddb.Table(g["table"]).put_item(Item=item, ConditionExpression="attribute_not_exists(runGroupId)")
    except Exception as ex:
        # ConditionalCheckFailed = 另一个区先建好了 ⇒ 加入它,不是错误
        if "ConditionalCheckFailed" not in str(type(ex).__name__) + str(ex):
            print("[run-group] 建组行失败(本次 run 继续;组行可由下一个区补建):%r" % (ex,))


def _run_group_accept(spec, run_group_id, run_id):
    """把「本区这次接下来了 + 本区产物的定义版本」写进组行的 accepted。

    🔴 定时那条路径:两个区若处于**不同定义版本**(一个区单独重发过),
       这里就会写出两个不同的 definitionVersion ⇒ 版本漂移在组页面上看得见,
       而**不是**把同一次触发拆成两个组(所以它刻意不进分组键)。
    🔴 写不上不让 run 失败(与建组行同一条理由):真值源是 run 行,这里只是注解。
    """
    g = spec.get("scheduledGroup") or {}
    target = (spec.get("stamp") or {}).get("targetId")
    if not run_group_id or not g or not target:
        return
    slot = {"runId": run_id}
    if g.get("definitionVersion") is not None:
        slot["definitionVersion"] = int(g["definitionVersion"])
    try:
        boto3.resource("dynamodb", region_name=spec["ctrlRegion"]).Table(g["table"]).update_item(
            Key={"runGroupId": run_group_id},
            ConditionExpression="attribute_exists(runGroupId)",
            UpdateExpression="SET #a.#t = :v",
            ExpressionAttributeNames={"#a": "accepted", "#t": target},
            ExpressionAttributeValues={":v": slot},
        )
    except Exception as ex:
        print("[run-group] 记 accepted 失败(不影响本次 run):%r" % (ex,))


def _scheduled_group_id(spec, at_epoch):
    """本次定时触发的确定性组键;没有 scheduledGroup(单区发布)⇒ None(不成组)。"""
    g = spec.get("scheduledGroup") or {}
    if not g:
        return None
    return _scheduled_run_group_id(g["definitionKind"], g["definitionId"], g["cron"], at_epoch)
# --- end ---`;
}
