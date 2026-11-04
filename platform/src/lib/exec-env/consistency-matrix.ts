// **版本一致性矩阵的聚合层**(50 INTERACTION §3.1 + §3.1a;格子语义在 `deployments.ts`)。
//
// ── 这张看板存在的理由 ────────────────────────────────────────────────────────
// 客户痛点原话是「**怕操作漏掉某个 region 导致数据对不上**」。矩阵就是那句话的正面回应:
// 行=定义、列=region、格子=已下发版本 + 状态色,**漏发 / 失败 / 版本不齐一眼可见**。
//
// ── 🔴 本文件最要紧的事不是"算出格子",是"**别误报**" ────────────────────────
// 误报与假绿一样致命:全屏黄之后三天就没人看它了,组件白做(§2bis.4 原文)。
// 施工时逮到两个会让看板**假红**的口子,已在 INTERACTION **§3.1a** 定案:
//   ① **下发路径还没接台账的资源类型不进矩阵**。`deployments` 属性不存在 ⇒ 每格都判 `never-deployed`
//      = ⚠漏发,而真相是"那类资源的发布压根没经过台账"。当前只有 **etl-job** 接了(W3-b 下半)。
//      ⇒ `MATRIX_COVERED` / `MATRIX_PENDING` 两个常量**如实登记覆盖面**,看板顶部照实说。
//   ② **从没发布过的定义(草稿)不进矩阵**。绑了 region 但一次都没点发布 ⇒ 判漏发,
//      而用户根本还没要求下发过。矩阵谈的是"**已下发的**一致性",草稿没有可比对象。
//
// ── 🔴 W3-d2:把「**建模产物**」行组混排进来(§3.1b)────────────────────────────
// 任务行的真值是"我发了什么"(`deployments` 台账),建模产物行的真值是"库里现在是什么"
// (`landedByTarget` **观测态**)。两者来源不同,但对用户是**同一个问题**:
// 「这个 region 到底缺不缺东西」⇒ 同一张矩阵、**同一批列**,横着一看就知道。
// 混排带来四个必须一次做对的点(每个都有门禁):
//   ③ 观测态 → 格子态走**穷举映射** `LANDED_TO_CELL`(漏一个态就编译不过;
//      写成 `?? "ok"` 会让新态静默变绿 = 假绿);
//   ④ `⊘缺写入通道` **不计入**需处理(按了也没用 ⇒ 计入就是天天误报;原「⊘被驻留门控」态已随不设法务门删除),
//      而 `drift` **要计入**(它是观测到的真不一致);
//   ⑤ 「一键处置」必须**按行类型派发**(`matrix-actions.ts`);混排前那条硬编码
//      会把 codeTableId 打进 `/api/etl-jobs/{id}/schedule`;
//   ⑥ `drift` **不给一键**:对齐它只能 DROP 重建(有损)⇒ 必须走建模页逐字确认。
//
// ── 🔴 列的取法:活跃 ∪ 出现过 ─────────────────────────────────────────────
// 只取活跃列会让"发到过某个后来被摘掉的 target"**整列消失** —— 那是本看板要抓的"漏"的反面(隐藏)。
// 非活跃列打 `active:false` 标,由界面标「已下线」,**不静默丢**。

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import {
  deploymentCellState,
  specializedTargetsOf,
  bindingShape,
  needsAttention,
  type CellState,
  type DeploymentRecord,
} from "@/lib/exec-env/deployments";
import { landedStateOf, type LandedRecord, type LandedState } from "@/lib/modeling/landing-shared";
import { currentDefinitionVersion } from "@/lib/versions/version-service";
import { projectFilter } from "@/lib/projects/guard";
import { matrixRepublishAction, type MatrixRowGroup } from "@/lib/exec-env/matrix-actions";

/**
 * 🔴 进矩阵的资源类型 —— **判据是"那条路径真写了逐 target 的真值"**:
 *  · `etl-job`:下发路径真写 `deployments` 台账(W3-b 下半);
 *  · `code-table` / `model-table`(**建模产物**,W3-d2 混排进来):落地路径真写 `landedByTarget`
 *    **观测态**(W3-d1)。它们与任务行的真值来源不同(一个是"我发了什么"、一个是"库里现在是什么"),
 *    但对用户是**同一个问题**:「这个 region 到底缺不缺东西」⇒ 同一张矩阵、同一批列。
 */
export const MATRIX_COVERED = ["etl-job", "code-table", "model-table"] as const;

/**
 * 建模产物的**观测态** → 矩阵格子态。
 *
 * 🔴 用 `Record<LandedState, CellState>` **强制穷举**:将来给 `LandedState` 加一个态,
 * 这里不补就**编译不过**。若写成 `switch + default` 或 `map[s] ?? "ok"`,新态会静默落进
 * 某个默认值 —— 而最可能的默认值是 `ok`,那就是**看板假绿**(合同点名要防的第一件事)。
 * (同一招在 `LandingPanel` 的 `STATE_UI` 上已经逮到过一次漏配的 `credential-gap`。)
 *
 * 🔴 `never-landed` 映到 `never-deployed`:同一个严重度(该有却没有),
 * 界面按行组给不同**文案**(任务=「漏发」/ 建模=「未落地」),但**严重度只有一处定义**。
 */
export const LANDED_TO_CELL: Record<LandedState, CellState> = {
  ok: "ok",
  stale: "stale",
  drift: "drift",
  failed: "failed",
  "never-landed": "never-deployed",
  "credential-gap": "credential-gap",
};

/**
 * 🔴 合同(SPEC §1.3a-S1)覆盖、但**下发路径还没接台账**的资源类型。
 * 看板顶部必须照实列出来 —— 不列 = 让用户以为"一屏看全了"。
 */
export const MATRIX_PENDING = ["sync", "engine-job", "workflow", "redshift-task", "flink-job"] as const;

/** 一次最多聚合多少行(每行要查一次版本快照)。超出**如实回报**,不静默截断。 */
export const MATRIX_ROW_CAP = 200;

export interface MatrixColumn {
  targetId: string;
  region: string;
  isHome: boolean;
  /** `false` = 注册表里已不活跃,但台账/绑定里还出现过 ⇒ 仍要显示(界面标「已下线」) */
  active: boolean;
}

export interface MatrixCell {
  state: CellState;
  /** 已下发的版本号(只有下发过才有) */
  version?: number;
  publishedAt?: number;
  error?: string;
  artifact?: string;
  /** 建模产物行:落地时的定义指纹 */
  defHash?: string;
  /**
   * 建模产物行:最近一次**真正观测**库里结构的时间。
   * 🔴 界面必须显示它 —— 「✓」只代表**那一刻**观测到的结构一致,之后被人改过平台并不知道。
   */
  observedAt?: string;
  /**
   * 🔴 **残留**:这个区有产物/下发记录,但当前**没绑**它。
   * 解绑不会删掉那个区已经建出来的物理表(建模产物**至今没有清理通道**,如实登记),
   * ⇒ 若按 `unbound` 画成「—」,那份留在别的法域里的数据就被**藏起来**了。
   * 不计入"需要处理"(用户按了也没有对应动作),但**必须显示**。
   */
  residual?: true;
}

export interface MatrixRow {
  type: string;
  /** 行组:任务(下发台账)/ 建模产物(落地观测)。呈现上混排,处置通道完全不同。 */
  group: MatrixRowGroup;
  id: string;
  name: string;
  shape: "shared" | "exclusive" | "specialized";
  targets: string[];
  /** 任务行:版本快照号(建模行没有版本快照 ⇒ **不给这个字段**,免得界面印出「v0」) */
  currentVersion?: number;
  /** 建模产物行:当前定义指纹(比对基准就是它) */
  currentDefHash?: string;
  /** 建模产物行:物理落点(schema.table),🔴 显示真实值不美化 */
  physical?: string;
  cells: Record<string, MatrixCell>;
  /** 需要处理的格子数(判据只有一处:`cellNeedsAttention`) */
  attention: number;
  scheduleEnabled: boolean;
  cronExpression?: string;
}

export interface MatrixResult {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  covered: string[];
  pending: string[];
  /** 如实登记被排除/截断的数量 */
  excluded: { unpublished: number; unlanded: number; truncated: boolean; cap: number };
  /**
   * 🔴 **口径如实登记**:任务行是**本项目**的,建模产物是**平台级全局**的(建模没有项目维度 ——
   * 这也正是非 home 建模落地缺凭证通道的根由,见 INTERACTION §4ter.a)。
   * 不说清楚,用户会以为这一屏都是"我项目里的东西"。
   */
  scope: { project: string[]; global: string[] };
  summary: { rows: number; attentionRows: number; attentionCells: number; actionableCells: number };
}

/**
 * 一个定义是否**已发布过**(§3.1a ②)。
 *
 * 🔴 判据是「`scheduleEnabled` 为真 **或** 台账非空」——
 * 只看台账会漏掉"发布成功但台账写失败"的行(那种行该留在矩阵里显红);
 * 只看 `scheduleEnabled` 会漏掉"已下线但台账还有历史条目"的行(它也该显出来让人清干净)。
 */
export function isPublishedDefinition(row: {
  scheduleEnabled?: unknown;
  deployments?: unknown;
}): boolean {
  if (row?.scheduleEnabled === true) return true;
  const d = row?.deployments;
  return Boolean(d && typeof d === "object" && Object.keys(d as Record<string, unknown>).length > 0);
}

/**
 * 一个**建模定义**是否进矩阵(§3.1b,与 `isPublishedDefinition` 同一条纪律)。
 *
 * 🔴 判据 = 「落过(有 `landedByTarget` 记录)**或** 显式绑过 region」。
 * 只建了定义、从没点过落地的码表是**草稿**:把它列进来会得到一整行「未落地」⚠ ——
 * 而用户根本还没要求落过。全屏黄三天后就没人看这张看板了(§2bis.4 原文)。
 *
 * ⚠️ 「显式绑过」判的是 `targets` 数组本身,**不能**用 `bindingTargets()`:后者对缺省行
 * 回落成 `["tgt_home"]`,于是每一个存量码表都会被判成"绑过 home" ⇒ 草稿全进矩阵。
 */
export function isLandedDefinition(row: { landedByTarget?: unknown; targets?: unknown }): boolean {
  const l = row?.landedByTarget;
  if (l && typeof l === "object" && Object.keys(l as Record<string, unknown>).length > 0) return true;
  return Array.isArray(row?.targets) && (row!.targets as unknown[]).length > 0;
}

/**
 * 一个格子要不要算进"需要处理" —— 🔴 **唯一判据**(行内计数、汇总、待处置清单全用它)。
 *
 * 除了状态本身,还要扣掉 `residual`:那个区**当前没绑**,平台也没有"清理残留"的动作,
 * 算进去就是一个用户永远处理不掉的红点(误报),但格子本身照实显示(不隐藏)。
 */
export function cellNeedsAttention(cell: { state: CellState; residual?: true }): boolean {
  return needsAttention(cell.state) && cell.residual !== true;
}

/** 建模产物一行的归一形态(码表 / 维度表共用一个作者)。 */
interface ModelingDef {
  type: "code-table" | "model-table";
  id: string;
  name: string;
  defHash: string;
  physical: string;
  targets: string[];
  explicitTargets: unknown;
  landedByTarget: Record<string, LandedRecord | undefined>;
}

/**
 * 读建模产物定义(码表 + 维度/事实表)。
 *
 * 🔴 **平台级全局、不过项目过滤器**:建模在本平台没有项目维度(码表/维度表由平台管理员统一管)。
 * 这不是漏了 `projectFilter` —— 是如实反映数据模型,并在 `scope` 里登记出来让界面照实说。
 */
async function loadModelingDefs(): Promise<ModelingDef[]> {
  const [{ listCodeTablesEnriched }, { listModelTablesEnriched }] = await Promise.all([
    import("@/lib/modeling/service"),
    import("@/lib/modeling/dimensions"),
  ]);
  const [cts, mts] = await Promise.all([listCodeTablesEnriched(), listModelTablesEnriched()]);
  const out: ModelingDef[] = [];
  for (const ct of cts as Array<Record<string, any>>) {
    out.push({
      type: "code-table",
      id: String(ct.codeTableId),
      name: String(ct.name || ct.code || ct.codeTableId),
      defHash: String(ct.defHash || ""),
      physical: String(ct.physicalTable || ""),
      targets: bindingTargets(ct as { targets?: unknown }),
      explicitTargets: ct.targets,
      landedByTarget: (ct.landedByTarget ?? {}) as Record<string, LandedRecord | undefined>,
    });
  }
  for (const mt of mts as Array<Record<string, any>>) {
    out.push({
      type: "model-table",
      id: String(mt.modelTableId),
      name: String(mt.name || mt.modelTableId),
      defHash: String(mt.defHash || ""),
      // `listModelTablesEnriched` 把 `schema.table` 放在 `physicalTable2`(`physicalTable` 是裸表名)
      physical: String(mt.physicalTable2 || `${mt.schema}.${mt.physicalTable}`),
      targets: bindingTargets(mt as { targets?: unknown }),
      explicitTargets: mt.targets,
      landedByTarget: (mt.landedByTarget ?? {}) as Record<string, LandedRecord | undefined>,
    });
  }
  return out;
}

/**
 * 算一个**建模产物**格子。
 *
 * 🔴 判定顺序:**有记录 ⇒ 先按观测态判**(记录是观测到的事实,哪怕这个区现在没绑 ——
 * 那正是"残留"要暴露的东西);没记录才谈"绑没绑"。
 * 顺序反了(先判未绑)会把"解绑后仍留在那个区的物理表"画成「—」= 把跨法域残留藏起来。
 */
export function modelingCell(args: {
  targetId: string;
  targets: readonly string[];
  defHash: string;
  landedByTarget: Record<string, LandedRecord | undefined>;
}): MatrixCell {
  const rec = args.landedByTarget[args.targetId];
  const bound = args.targets.includes(args.targetId);
  if (!rec) return { state: bound ? LANDED_TO_CELL["never-landed"] : "unbound" };
  const cell: MatrixCell = {
    state: LANDED_TO_CELL[landedStateOf(rec, args.defHash)],
    ...(rec.defHash ? { defHash: rec.defHash } : {}),
    ...(rec.observedAt ? { observedAt: rec.observedAt } : {}),
    ...(rec.error ? { error: rec.error } : {}),
    ...(rec.table ? { artifact: rec.table } : {}),
  };
  if (!bound) cell.residual = true;
  return cell;
}

/**
 * 算整张矩阵。
 *
 * @param projectId 项目隔离:**任务行**只聚合本项目的定义(与列表页同一条 `projectFilter` 判据);
 *                  建模产物是平台级全局的(见 `loadModelingDefs` 与 `scope`)。
 */
export async function buildConsistencyMatrix(projectId: string): Promise<MatrixResult> {
  // ── 任务行:etl-job(接了下发台账,见文件头 ①)──
  const { clause, values } = projectFilter(projectId);
  const items: Record<string, any>[] = [];
  let startKey: Record<string, unknown> | undefined;
  // 🔴 必须翻页:DDB 的 `Limit` 在 `FilterExpression` **之前**生效,单页就返回会静默漏行
  // (同 `registry.queryAllPages` 与 `redshift/history` 的那条纪律)。
  for (let page = 0; page < 20; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.ETL_JOBS,
        KeyConditionExpression: "userId = :uid",
        FilterExpression: clause,
        ExpressionAttributeValues: { ":uid": "default-user", ...values },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    items.push(...((r.Items as Record<string, any>[] | undefined) ?? []));
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }

  const published = items.filter(isPublishedDefinition);
  const unpublished = items.length - published.length;
  const use = published.slice(0, MATRIX_ROW_CAP);

  // ── 建模产物行:码表 + 维度/事实表(接了 `landedByTarget` 观测态,W3-d1)──
  const allModeling = await loadModelingDefs();
  const landedDefs = allModeling.filter((d) =>
    isLandedDefinition({ landedByTarget: d.landedByTarget, targets: d.explicitTargets })
  );
  const unlanded = allModeling.length - landedDefs.length;
  const useModeling = landedDefs.slice(0, MATRIX_ROW_CAP);
  // 🔴 两组各自封顶,但截断这件事**一处回报**:哪一组超了都要在界面上说,不许静默少几行
  const truncated = published.length > MATRIX_ROW_CAP || landedDefs.length > MATRIX_ROW_CAP;

  // ── 列:活跃 target ∪ 行里出现过的 target(见文件头「列的取法」)──
  const { listActiveTargets } = await import("@/lib/exec-env/registry");
  let activeTargets: Array<{ targetId: string; region?: string }> = [];
  try {
    activeTargets = (await listActiveTargets()) as Array<{ targetId: string; region?: string }>;
  } catch {
    // 🔴 读注册表失败**不许静默回落成"只有 home"** —— 那会让所有非 home 列消失 = 隐藏问题。
    // 这里抛给路由,由它回 502(空列表比报错更危险,与 `/api/exec-targets` 同一条判据)。
    throw new Error("读取执行目标清单失败,无法可靠地算矩阵(空/缺列会把「漏发」隐藏掉)");
  }
  const activeIds = new Set(activeTargets.map((t) => t.targetId));
  const regionOf = new Map(activeTargets.map((t) => [t.targetId, String(t.region || "")]));

  const seen = new Set<string>([HOME_TARGET_ID, ...Array.from(activeIds)]);
  for (const it of use) {
    for (const t of bindingTargets(it)) seen.add(t);
    for (const t of Object.keys((it.deployments ?? {}) as Record<string, unknown>)) seen.add(t);
  }
  // 🔴 建模产物的 target 也要并进来:一张**只落在某个已摘掉的区**的表,若那一列不出现,
  //    那份留在那儿的数据就彻底看不见了(与任务行同一条"活跃 ∪ 出现过"纪律)。
  for (const d of useModeling) {
    for (const t of d.targets) seen.add(t);
    for (const t of Object.keys(d.landedByTarget)) seen.add(t);
  }
  const columns: MatrixColumn[] = Array.from(seen)
    .map((targetId) => ({
      targetId,
      region: regionOf.get(targetId) || "",
      isHome: isHome(targetId),
      active: activeIds.has(targetId),
    }))
    // home 最前,其余按 targetId 稳定排序(列顺序不许随注册表返回顺序抖动)
    .sort((a, b) => (a.isHome ? -1 : b.isHome ? 1 : a.targetId.localeCompare(b.targetId)));

  // ── 格子 ──
  const rows: MatrixRow[] = [];
  for (const it of use) {
    const bound = bindingTargets(it);
    const spec = specializedTargetsOf(it);
    // 🔴 当前版本取**版本快照表**,不在资源行上再存一份(两个真值源必然漂移,
    //    而漂移的表现恰好是"矩阵说版本不齐、其实是它自己记错了")。
    const currentVersion = await currentDefinitionVersion("etl-job", String(it.jobId));
    const deployments = (it.deployments ?? {}) as Record<string, DeploymentRecord | undefined>;
    const cells: Record<string, MatrixCell> = {};
    let attention = 0;
    for (const col of columns) {
      const state = deploymentCellState({
        targetId: col.targetId,
        targets: bound,
        currentVersion,
        deployments,
        specializedTargets: spec,
        // ⚠️ `dataUnavailable` 的生产者仍未落地(见 `deployments.ts` 文件头的如实登记):
        // 这里**不传**,而不是瞎猜一个值 —— 猜错会把"数据不可用"与"未绑定"混成一件事。
      });
      const d = deployments[col.targetId];
      const cell: MatrixCell = {
        state,
        ...(d?.version !== undefined ? { version: d.version } : {}),
        ...(d?.publishedAt !== undefined ? { publishedAt: d.publishedAt } : {}),
        ...(d?.error ? { error: d.error } : {}),
        ...(d?.artifact ? { artifact: d.artifact } : {}),
      };
      // 有下发记录却当前没绑这个区 ⇒ 残留(下线流程本该把台账条目撤掉,还在就说明有东西没清干净)
      if (d && !bound.includes(col.targetId)) cell.residual = true;
      cells[col.targetId] = cell;
      if (cellNeedsAttention(cell)) attention++;
    }
    rows.push({
      type: "etl-job",
      group: "task",
      id: String(it.jobId),
      name: String(it.name || it.jobId),
      shape: bindingShape(bound, spec),
      targets: bound,
      currentVersion,
      cells,
      attention,
      scheduleEnabled: it.scheduleEnabled === true,
      ...(it.cronExpression ? { cronExpression: String(it.cronExpression) } : {}),
    });
  }

  // ── 建模产物行的格子(同一批列 ⇒ 同一屏能横着看"这个 region 到底缺什么")──
  for (const d of useModeling) {
    const cells: Record<string, MatrixCell> = {};
    let attention = 0;
    for (const col of columns) {
      const cell = modelingCell({
        targetId: col.targetId,
        targets: d.targets,
        defHash: d.defHash,
        landedByTarget: d.landedByTarget,
      });
      cells[col.targetId] = cell;
      if (cellNeedsAttention(cell)) attention++;
    }
    rows.push({
      type: d.type,
      group: "modeling",
      id: d.id,
      name: d.name,
      shape: bindingShape(d.targets),
      targets: d.targets,
      currentDefHash: d.defHash,
      physical: d.physical,
      cells,
      attention,
      // 建模产物不参与调度(它是"库里该有什么",不是"什么时候跑")
      scheduleEnabled: false,
    });
  }

  // 🔴 需处理的行排最前(看板的价值就是"要管的先看见");同等则任务组在前、再按名字稳定排序
  rows.sort(
    (a, b) =>
      b.attention - a.attention ||
      (a.group === b.group ? 0 : a.group === "task" ? -1 : 1) ||
      a.name.localeCompare(b.name)
  );

  const tasks = attentionTasks({ rows } as MatrixResult);
  return {
    columns,
    rows,
    covered: [...MATRIX_COVERED],
    pending: [...MATRIX_PENDING],
    excluded: { unpublished, unlanded, truncated, cap: MATRIX_ROW_CAP },
    scope: { project: ["etl-job"], global: ["code-table", "model-table"] },
    summary: {
      rows: rows.length,
      attentionRows: rows.filter((r) => r.attention > 0).length,
      attentionCells: rows.reduce((n, r) => n + r.attention, 0),
      // 🔴 「一键处置」能真正动手的格子数 ≤ 需要处理的格子数(drift 要人工逐字确认)。
      //    按钮上写的数必须是**这个**数,否则点下去"处理 5 个"实际只动了 3 个(过度承诺)。
      actionableCells: tasks.filter((x) => x.actionable).length,
    },
  };
}

/** 待处置清单的一条(界面按 `actionable` 决定"能一键"还是"只提示")。 */
export interface AttentionTask {
  type: string;
  group: MatrixRowGroup;
  id: string;
  name: string;
  targetId: string;
  state: CellState;
  /** 🔴 能不能一键处置。false 时 `skipReason` 必有值 —— 静默跳过 = 用户以为已经处理了 */
  actionable: boolean;
  skipReason?: string;
  cronExpression?: string;
}

/**
 * 把矩阵里"需要处理"的格子摊平成待处置清单(给「一键处置全部不一致项」用)。
 *
 * 🔴 判据只有一处:`cellNeedsAttention`(= `ATTENTION_STATES` 减去残留格)。
 * 在这里重新列一遍状态,就会有一天与看板计数不一致 —— 表现是"看板显红、批量却跳过它"。
 *
 * 🔴 每条都带 `type` 与 `actionable`:混排之后**不许**再假定"待处置的都是任务、都能打调度端点"
 * (那会拿一个 codeTableId 去发 DAG)。能不能动手由 `matrixRepublishAction` 这一份派发表说。
 */
export function attentionTasks(m: Pick<MatrixResult, "rows">): AttentionTask[] {
  const out: AttentionTask[] = [];
  for (const r of m.rows) {
    for (const [targetId, cell] of Object.entries(r.cells)) {
      if (!cellNeedsAttention(cell)) continue;
      const plan = matrixRepublishAction(
        { type: r.type, id: r.id, group: r.group, ...(r.cronExpression ? { cronExpression: r.cronExpression } : {}) },
        targetId,
        cell.state
      );
      out.push({
        type: r.type,
        group: r.group,
        id: r.id,
        name: r.name,
        targetId,
        state: cell.state,
        actionable: plan.kind === "post",
        ...(plan.kind === "skip" ? { skipReason: plan.reason } : {}),
        ...(r.cronExpression ? { cronExpression: r.cronExpression } : {}),
      });
    }
  }
  return out;
}
