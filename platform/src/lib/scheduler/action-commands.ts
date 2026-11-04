// @kf-batch 50-WP28-platform-action-node
// 🔴🔴 **「按时跑一次平台动作」的合同** —— 命令行形状 + 可下发动作的**白名单**(安全边界)。
//
// 【为什么需要它(WP-28 立包勘定)】造数 / 治理 / 问数三条「下发执行」缺口是**同一件事的三个实例**:
//   「按时跑一次**平台**动作」。而调度运行期(MWAA Serverless 里的 DAG)只有 boto3:
//   `_exec_sql` 直连 Redshift Data API、`_exec_sync` 直接 `glue.start_job_run`。
//   平台**没有任何机器身份入口**(`guardResourceAccess` 一律要一个登录身份)。
//   若让三条各自在 python 里把平台那条链重写一遍(问数要重写掩码 + 卡片 schema + 驻留审计,
//   治理要重写目录同步 / 规则执行,造数要重写落点解析)⇒ **三个第二作者**,
//   而「同一件事两个作者」正是本轮一路在修的那类缺陷。
//
// 【为什么传输是 DynamoDB,不是 SQS】用户 2026-09-20 拍的是「消费端 = 主控区的 Lambda」,这一点不变。
//   而**传输**必须是 DDB:`infra/lib/exec-env/endpoints.ts` 写得很明确 ——
//   「要经跨区私网通路回主控区的服务:目前**只有 home 的 DynamoDB**(运行台账回写)」,
//   SPEC §3.14「控制面回写 = **唯一**跨区例外」。执行环境是**零出网**的(WP-16),
//   用 SQS 就得给那条通路再加一个服务(home 侧接口端点 + 每个执行区一个 PHZ + SG)
//   = 给一条用户在意的不变量**新开一个例外**。而 DDB 那条例外**已经存在、天天在用**
//   (DAG 的 run 台账就是这么写回来的:`_mk` 里 `boto3.resource("dynamodb", region_name=ctrl_region)`)
//   ⇒ 命令落主控区的命令表 = **零新增网络**;消费端用 **DynamoDB Streams → Lambda**,连轮询都省了。
//
// 【形状的单一作者】python 侧(写命令)与 TS 侧(读命令 / 消费)必须用**同一套属性名**。
//   这条在本仓有先例也有血:`run-stamp-mwaa-parity.test.ts` 就是钉「两侧属性名同源」的 ——
//   改一侧漏另一侧,症状是「接口 200 而谁都找不到这次运行」。所以属性名在这里列一次,两侧都从这儿取。

/** 命令行的属性名(python 写 / TS 读,**同一份事实**)。 */
export const ACTION_COMMAND_ATTRS = [
  "commandId",     // pk:运行期生成(毫秒时间戳 + 随机段,字典序 ≈ 时间序)
  "action",        // 白名单里的动作 id
  "targetId",      // 在**哪个执行范围**上跑(动作在中心执行,region 是参数)
  "projectId",     // 归属项目(审计与权限都按它)
  "params",        // 动作自己的参数(由 `validateActionParams` 逐个动作约束)
  "runId",         // 发起它的那次 DAG run(台账可回指)
  "taskId",        // 发起它的那个调度对象(治理定时任务 / 卡片定时刷新)
  "requestedAt",
  "status",        // pending | running | succeeded | failed
  "startedAt",     // 消费端抢单成功的时刻(running 的租约从这里算)
  "finishedAt",
  "error",
  "summary",       // 成功时的非数据摘要(计数 / 分数 / 时间戳),给台账与日志看
  "ttl",           // 命令是**一次性**的,7 天后自动清(它不是台账,台账在 bgp-task-runs)
] as const;

/** 命令的生命周期状态。🔴 `pending` 是**唯一**的初始态:消费端靠条件写从 pending → running 抢单。 */
export const ACTION_COMMAND_STATUSES = ["pending", "running", "succeeded", "failed"] as const;
export type ActionCommandStatus = (typeof ACTION_COMMAND_STATUSES)[number];
/** 终态(两侧同源:python 轮询到这两个之一就停)。 */
export const ACTION_COMMAND_TERMINAL: readonly ActionCommandStatus[] = ["succeeded", "failed"] as const;

/**
 * 🔴🔴 **可下发动作的白名单** = 安全边界。
 *
 * 内部身份(消费端 Lambda 用的那个)**只能**调这里列出的动作,绝不是「平台 API 的通用钥匙」。
 * 每一条都要写清:手动入口是哪个产品路由 + 两条路共用的**库函数**(⇒ 动作永远只有一个作者)、
 * 它服务哪一类能力(⇒ 与三维矩阵对得上)、以及**为什么它可以被无人值守地触发**(有些动作天生不该定时跑,比如删除)。
 *
 * @kf-batch 50-WP28-platform-action-node(2026-10-10 序 33 施工)
 * 🔴 原来三条治理动作的 `route` **写的是不存在的路由**(`metadata-sync` / `quality` / `classification/scan`),
 *    判据只断 `/api/` 前缀,于是谁也没发现。现在判据钉「路由文件真实存在」+「库函数真实导出」。
 * 🔴 `seed.run-once` 曾经删过一次:它当时指向的 `/api/admin/seed/run` 从来没有实现,造数也没有可共用的库函数
 *    (白名单里留一个「没有作者的动作」= 一条随时会被人接上、而接上那一刻就是第二个作者的口子)。
 * @kf-batch 50-CAPSEED-seed-dispatch(登记 CAP-SEED 交付)
 *    现在**按同一形状加回来**:作者 = `lib/seed/run-once#runSeedOnce`(手动路由 `/api/seed/run` 与消费端共用),
 *    判据照样钉「路由文件真实存在 + 库函数真实导出 + 路由真调用它」。
 */
export interface DispatchableAction {
  /** 命令里的 `action` 值。 */
  id: string;
  /** 给人看的名字(页面上配 cron 时显示)。 */
  label: string;
  /** 手动触发时走的产品路由(相对 `app/`,动态段用 `[x]`)—— 判据钉它真实存在。 */
  route: string;
  /** HTTP 方法。 */
  method: "POST" | "GET";
  /**
   * 手动路由与消费端**共用**的那个库函数(`模块路径#导出名`)。
   * 🔴 消费端**只许调它**,不许在 python 或内部端点里重写业务逻辑 —— 判据钉它真实导出。
   */
  author: string;
  /** 它服务三维矩阵里的哪一类能力(`governance` / `genbi` …)。 */
  capability: string;
  /** 为什么它可以被无人值守触发(只读 / 幂等 / 可重跑)。 */
  whyUnattended: string;
}

export const DISPATCHABLE_ACTIONS: readonly DispatchableAction[] = [
  {
    id: "governance.catalog-sync",
    label: "目录同步(该区元数据推进 OpenMetadata)",
    route: "/api/admin/metadata-mirror",
    method: "POST",
    author: "lib/exec-env/metadata-mirror#mirrorMetadata",
    capability: "governance",
    whyUnattended: "幂等:重复跑只会把该区的目录刷到最新;不删任何东西,失败可直接重跑",
  },
  {
    id: "governance.quality-check",
    label: "质量检查(按该区数仓跑规则)",
    route: "/api/governance/quality-run",
    method: "POST",
    author: "lib/quality/service#runChecks",
    capability: "governance",
    whyUnattended: "只读 + 追加结果:规则跑在该区数仓上,产出一条检查结果,不改业务数据",
  },
  {
    id: "governance.sensitive-scan",
    label: "敏感扫描(该区表的分级命中)",
    route: "/api/governance/sensitive-scan",
    method: "POST",
    author: "lib/governance/sensitive/scan#runSensitiveScan",
    capability: "governance",
    whyUnattended: "只读 + 追加命中记录;分级本身由人确认,扫描只给候选",
  },
  {
    id: "seed.run-once",
    label: "在该区下发一次造数(重建示范数据集)",
    route: "/api/seed/run",
    method: "POST",
    author: "lib/seed/run-once#runSeedOnce",
    capability: "seed",
    whyUnattended:
      "确定性重建:造数作业按固定种子重写该区的示范数据集(同样的表、同样的行数与取值),重复跑结果不变;" +
      "只碰示范库 gamedata,不碰业务数据;生产模式部署不建造数作业 ⇒ 生产里这个动作恒失败(作业不存在),不会造出假数据",
  },
  {
    id: "genbi.card-refresh",
    label: "定时刷新问数卡片(重跑卡片里存下的那条 SQL)",
    route: "/api/genbi/cards/[cardId]/refresh",
    method: "POST",
    author: "lib/genbi/cards-refresh#refreshCardOnce",
    capability: "genbi",
    whyUnattended:
      "只读:重跑卡片里已存的只读 SELECT(不调大模型),结果按最严口径脱敏后写回同一张卡并留一份运行快照;正文仍落该区",
  },
] as const;

/** 治理三类动作(治理定时任务只许选这三个;单一事实源,页面与服务端都从这里取)。 */
export const GOVERNANCE_ACTION_IDS = ["governance.catalog-sync", "governance.quality-check", "governance.sensitive-scan"] as const;
export type GovernanceActionId = (typeof GOVERNANCE_ACTION_IDS)[number];
/** 问数卡片定时刷新(用户 2026-10-10 默认方案:刷新**同一张**卡 + 保留运行快照历史,不占 100 张额度)。 */
export const CARD_REFRESH_ACTION_ID = "genbi.card-refresh" as const;

/** 造数(登记 CAP-SEED 交付):在该区重建一次示范数据集。 */
export const SEED_ACTION_ID = "seed.run-once" as const;
/**
 * 可造的数据集(闭合词表)。🔴 本期只有一套:游戏广告分析 `gamedata`(主控区 = 灌源库 MySQL;其它区 = 写该区湖 + Glue 目录,
 * 两边同构,见 scripts/seed_game.py 与 seed_game_region.py)。参数必须**点名**数据集 —— 不给默认值。
 */
export const SEED_DATASETS = ["gamedata"] as const;
export type SeedDataset = (typeof SEED_DATASETS)[number];

/** 目录同步可选的来源(与 `metadata-mirror-shared.ts` 的 `MIRROR_SOURCES` 同值;判据钉两处相等)。 */
export const CATALOG_SYNC_SOURCES = ["glue", "redshift"] as const;
/** 质量检查一次最多几张表(成本护栏:每张表一组规则 SQL)。 */
export const QUALITY_CHECK_MAX_TABLES = 50;

/**
 * 逐个动作的参数校验(**纯函数**,fail-closed)。返回 `null` = 合法;否则回人话拒因。
 * 🔴 建定时任务时(页面 → 路由)与消费端执行前**用的是同一个函数** —— 两处各判一遍就是两个作者。
 * 🔴 「空输入」一律拒:没有表的质量检查 / 没有来源的目录同步,跑起来就是「成功地什么都没做」。
 */
export function validateActionParams(action: string, params: unknown): string | null {
  const p = (params && typeof params === "object" && !Array.isArray(params) ? params : null) as Record<string, unknown> | null;
  if (!isDispatchableAction(action)) return `动作 ${JSON.stringify(action)} 不在可下发白名单里`;
  if (!p) return "params 必须是对象";
  const strList = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : null;
  switch (action) {
    case "governance.catalog-sync": {
      const src = strList(p.sources);
      if (!src || src.length === 0) return "目录同步必须点名至少一个来源(glue / redshift)—— 不给默认值";
      const bad = src.filter((s) => !(CATALOG_SYNC_SOURCES as readonly string[]).includes(s));
      if (bad.length) return `目录同步的来源只能是 ${CATALOG_SYNC_SOURCES.join(" / ")}(收到 ${JSON.stringify(bad)})`;
      return null;
    }
    case "governance.quality-check": {
      const fqns = strList(p.fqns);
      if (!fqns || fqns.length === 0) return "质量检查必须点名至少一张表(fqns)—— 空清单跑起来就是「成功地什么都没检查」";
      if (fqns.length > QUALITY_CHECK_MAX_TABLES) return `质量检查一次最多 ${QUALITY_CHECK_MAX_TABLES} 张表(收到 ${fqns.length})`;
      return null;
    }
    case "governance.sensitive-scan": {
      if (p.schema !== undefined && (typeof p.schema !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.schema))) {
        return "schema 只能是合法标识符";
      }
      if (p.tables !== undefined && strList(p.tables) === null) return "tables 必须是字符串数组";
      return null;
    }
    case "seed.run-once": {
      if (typeof p.dataset !== "string" || !p.dataset.trim()) return "造数必须点名数据集(dataset)—— 不给默认值";
      if (!(SEED_DATASETS as readonly string[]).includes(p.dataset)) {
        return `造数的数据集只能是 ${SEED_DATASETS.join(" / ")}(收到 ${JSON.stringify(p.dataset)})`;
      }
      const extra = Object.keys(p).filter((k) => k !== "dataset");
      if (extra.length) return `造数不接受这些参数:${extra.join(", ")}(规模由该区部署期的造数作业决定)`;
      return null;
    }
    case "genbi.card-refresh": {
      for (const k of ["cardId", "ownerSub", "ownerUsername"]) {
        if (typeof p[k] !== "string" || !(p[k] as string).trim()) return `卡片定时刷新缺 ${k}`;
      }
      if (p.turnIndex !== undefined && !(Number.isInteger(p.turnIndex) && (p.turnIndex as number) >= 0)) {
        return "turnIndex 必须是 ≥0 的整数";
      }
      return null;
    }
    default:
      // 🔴 白名单里加了动作却没在这里写校验 ⇒ 拒(不许「没写校验 = 什么都放行」)
      return `动作 ${action} 没有参数校验 —— 新增动作必须同笔写校验`;
  }
}

export function findDispatchableAction(id: unknown): DispatchableAction | undefined {
  return DISPATCHABLE_ACTIONS.find((a) => a.id === id);
}

/** 🔴 白名单外的动作一律拒 —— 这一句就是那道边界,别在别处再判一遍。 */
export function isDispatchableAction(id: unknown): boolean {
  return Boolean(findDispatchableAction(id));
}

/**
 * 命令表名(建表在 infra `lib/action-dispatch.ts`,随消费端 Lambda 同一个构件;开 Streams + `ttl` 属性 TTL)。
 * 🔴 python 侧写的是同一个字面量(`node-exec-py.ts` 的 `_ACTION_COMMANDS_TABLE`),判据钉两侧相等。
 */
export const ACTION_COMMANDS_TABLE = process.env.ACTION_COMMANDS_TABLE || "bgp-action-commands";

/** 命令的 TTL:7 天。命令**不是**台账 —— 运行历史永远在 `bgp-task-runs`,这张表只是传声筒。 */
export const ACTION_COMMAND_TTL_DAYS = 7;

/**
 * running 的租约:消费端抢单之后最多这么久还没写终态 ⇒ 视为执行体丢了(平台容器重启 / 部署滚动)。
 * python 侧轮询到「running 且超租约」就让 task 失败(不许无限等,也不许当成功)。两侧同源。
 */
export const ACTION_COMMAND_LEASE_MINUTES = 40;
/** pending 最长等多久没人抢单 ⇒ 消费端不在(Lambda 没部署 / 流没接上),python 侧让 task 失败并说清。 */
export const ACTION_COMMAND_PICKUP_MINUTES = 5;

export interface ActionCommand {
  commandId: string;
  action: string;
  targetId: string;
  projectId?: string;
  params?: Record<string, unknown>;
  runId?: string;
  taskId?: string;
  requestedAt: string;
  status: ActionCommandStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/**
 * 解析一条命令行。**纯函数**,fail-closed:形态不对就回 `null`(调用方据此拒,不许猜)。
 * 🔴 「猜」的代价在本仓有案底:非 home 的数仓落点猜错不会报错,而是「看起来正常地连到了别的区域」。
 */
export function parseActionCommand(row: unknown): ActionCommand | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string) : "");
  const commandId = str("commandId");
  const action = str("action");
  const targetId = str("targetId");
  const requestedAt = str("requestedAt");
  const status = str("status");
  if (!commandId || !action || !targetId || !requestedAt) return null;
  if (!isDispatchableAction(action)) return null;          // 白名单外 ⇒ 不是一条合法命令
  if (!(ACTION_COMMAND_STATUSES as readonly string[]).includes(status)) return null;
  return {
    commandId,
    action,
    targetId,
    requestedAt,
    status: status as ActionCommandStatus,
    ...(str("projectId") ? { projectId: str("projectId") } : {}),
    ...(r.params && typeof r.params === "object" ? { params: r.params as Record<string, unknown> } : {}),
    ...(str("runId") ? { runId: str("runId") } : {}),
    ...(str("taskId") ? { taskId: str("taskId") } : {}),
  };
}
