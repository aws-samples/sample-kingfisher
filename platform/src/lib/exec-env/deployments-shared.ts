// **版本一致性矩阵的格子语义**(INTERACTION §3.1 / §2bis.4 / §3.1b)—— **纯函数,唯一作者**。
//
// 🔴 **为什么从 `deployments.ts` 拆出来**:台账写入要 `@aws-sdk/lib-dynamodb`,而看板页面是
// **客户端组件**,import 它就会把 AWS SDK 拖进浏览器包 ⇒ 于是页面里只能**再抄一份**
// 「哪些态需要处理」。抄两份的表现恰好是:**落地面板/接口说要处理、看板画成不用管**
// (W3-d2 开工前那份 `CELL_UI` 里就已经硬写了一列 `attention: boolean`)。
// ⇒ 判态与"需不需要处理"这两件事只许有一处定义,前后端都 import 这里
//   (与 `modeling/landing-shared.ts` 同一条纪律)。

/** 单个 (定义 × target) 的下发记录(S1 的 `deployments` 值形态)。 */
export interface DeploymentRecord {
  /** 下发时该定义的版本号(`snapshotVersion` 的递增号) */
  version: number;
  publishedAt: number;
  status: "ok" | "failed";
  error?: string;
  /** 下发产物的标识(如 DAG id),便于从看板直达产物 */
  artifact?: string;
  /** 这份产物走的调度器(缺省 = 经典 mwaa,存量行没有此字段) */
  scheduler?: "mwaa" | "serverless";
  /** serverless:workflow 的 ARN / 版本(下线与观测按它找) */
  workflowArn?: string;
  workflowVersion?: string;
}

/**
 * 矩阵格子的状态。🔴 **四个免判态**(`unbound`/`specialized`/`unavailable`/`credential-gap`)不参与红黄判定
 * (§2bis.4 三类 + §3.1b 一类;:`residency-blocked` 已删 —— 不设法务门)。
 *
 * ⚠️ **谁产出哪个态**(别在这里猜):
 *  · 前 7 个由 `deploymentCellState()`(任务行)产出;
 *  · `drift` / `credential-gap` **只可能**来自建模产物行 ——
 *    它们由 `LANDED_TO_CELL`(`consistency-matrix.ts`)从**观测态** `LandedState` 映射而来。
 *    ⇒ `deploymentCellState()` 结构上产不出这两个,这一点由门禁钉住。
 */
export type CellState =
  | "unbound" // — 未绑定(正常:区域专属任务在别的区就该是这个)
  | "specialized" // 🔶 已特化(本就该不同,不判不齐)
  | "unavailable" // ⊘ 数据不可用(该区没有它引用的数据)
  | "never-deployed" // ⚠ 绑了但从没下发过 —— 这就是"漏发"
  | "stale" // ⚠ 版本不齐(下发过,但是旧版本)
  | "failed" // ✗ 下发失败
  | "ok" // ✓ 一致
  // ── 以下两态由**建模产物行**引入(§3.1b);任务行永不出现 ──
  | "drift" // 🔴 该区已存在结构不同的同名产物,平台**没有覆盖**它
  | "credential-gap"; // ⊘ 缺写入通道(合同缺口,用户在那个区做不了任何事)

/**
 * 只有这四个态参与"不一致/需处理"的计数与高亮。
 *
 * 🔴 `drift` 必须在里面:它是**观测到的不一致**(库里那张表不是平台定义的样子),
 * 与「版本不齐」同级要人处置。而 `credential-gap` **绝不能**在里面 ——
 * 用户按了也没用(平台还没有通道),算进去就是天天误报。
 *
 * 🔴 这份清单必须与建模侧的 `LANDED_ATTENTION` **口径一致**(经 `LANDED_TO_CELL` 映射后逐态相等),
 * 否则会出现"落地面板说要处理、看板说没事"这种同一件事两个说法 —— 有门禁逐态比对。
 */
export const ATTENTION_STATES: readonly CellState[] = ["never-deployed", "stale", "failed", "drift"] as const;

export function needsAttention(state: CellState): boolean {
  return ATTENTION_STATES.includes(state);
}

/**
 * 算一个**任务行**格子的状态。**纯函数,判定顺序即语义**。
 *
 * 🔴 顺序不可重排:`unavailable` / `specialized` / `unbound` 必须排在**最前** ——
 * 它们是"本来就不该有值"的三种情形。若排在 `never-deployed` 之后,一个区域专属任务
 * 在其它区都会被判成"漏发" ⇒ 看板全屏黄色 ⇒ 误报把真问题淹掉。
 */
export function deploymentCellState(args: {
  targetId: string;
  /** 该定义绑定的 target 集合(已归一,见 `bindingTargets`) */
  targets: readonly string[];
  /** 该定义当前的版本号 */
  currentVersion: number;
  deployments?: Record<string, DeploymentRecord | undefined> | null;
  /** 该 (定义 × target) 已特化(脱离共享定义,不随主定义更新) */
  specializedTargets?: readonly string[];
  /** 🔴 数据异质:该 target 上它引用的数据不可达(生产者见 `deployments.ts` 文件头的如实登记) */
  dataUnavailable?: boolean;
}): CellState {
  const { targetId, targets, currentVersion } = args;
  // ① 数据不可用 —— 最强的"本就不该有":连绑都不该绑
  if (args.dataUnavailable) return "unavailable";
  // ② 已特化 —— 它就该与主定义不同
  if ((args.specializedTargets ?? []).includes(targetId)) return "specialized";
  // ③ 未绑定 —— 区域专属任务的正常形态
  if (!targets.includes(targetId)) return "unbound";
  // ④ 以下才是真的"该有却不对"
  const d = (args.deployments ?? {})[targetId];
  if (!d) return "never-deployed";
  if (d.status === "failed") return "failed";
  // 🔴 判据是 `!==` 而不是 `<`。下发版本**高于**当前定义版本听起来不可能,但定义被回滚
  // (版本快照支持回滚)时就会出现。那种格子**不是 ok** —— 库里跑的是一个已经被撤回的版本,
  // 而处置与 stale 完全一样(重发对齐)⇒ 归同一态,文案说"版本不一致"而不是"版本旧"。
  // 用 `<` 会把这种格子判成绿,那正是"看板假绿"。
  if (d.version !== currentVersion) return "stale";
  return "ok";
}

/** 一行(一个定义)的汇总:有几个格子需要处理。 */
export function rowAttentionCount(states: readonly CellState[]): number {
  return states.filter(needsAttention).length;
}

/**
 * 绑定形态(INTERACTION §2bis.2:任务列表要一眼可辨"这个任务是不是所有区域都跑")。
 *
 * 🔴 `区域专属` 是**一等公民、不是异常**:只绑一个区的任务不该被看板报"缺失"。
 */
export type BindingShape = "shared" | "exclusive" | "specialized";

export function bindingShape(targets: readonly string[], specializedTargets?: readonly string[]): BindingShape {
  if ((specializedTargets ?? []).length > 0) return "specialized";
  return targets.length > 1 ? "shared" : "exclusive";
}

/** 读侧:把资源行的 `specializedFrom` map 归一成 target 列表。 */
export function specializedTargetsOf(row: { specializedFrom?: unknown } | null | undefined): string[] {
  const m = row?.specializedFrom;
  if (!m || typeof m !== "object") return [];
  return Object.keys(m as Record<string, unknown>);
}
