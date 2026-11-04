// **看板格子的「处置」派发表**(INTERACTION §3.1b)—— 纯函数,客户端与门禁共用。
//
// ── 🔴 为什么这件事必须是一张**纯函数派发表**,而不是页面里的 if ─────────────────
// W3-d2 把「建模产物」行组混排进了矩阵。混排之前,看板里只有 etl-job 一种行,
// 于是「重发到此 region」与「一键重发全部不一致项」都**硬编码**打
// `/api/etl-jobs/{id}/schedule`。混排之后,那条硬编码会**把码表/维度表的 id 打进任务调度端点** ——
// 拿一个 codeTableId 去发 DAG。这类"多一种行就走错端点"的错在页面里极难被门禁钉住,
// ⇒ 派发表抽出来,并配一条**覆盖面门禁**:`MATRIX_COVERED` 里每一种行类型都必须在这里有落点,
//   未知类型**只许 skip**、绝不回落到任务端点(回落 = 拿别的资源 id 去调调度接口)。
//
// ── 🔴 第二件事:`drift` **不给一键处置** ────────────────────────────────────
// 建模产物的 drift 意思是「该区已有一张结构不同的同名表,平台没有覆盖它」。
// 让它对齐只有一条路 —— **DROP 后按平台定义重建**,那是**有损**操作(表里的数据一起消失,
// 而且那张表可能是别人建的、正被别的作业写入)。所以它必须走建模页落地面板的**逐字确认串**,
// 看板上的一键/批量**刻意不做** —— 并且要把"为什么不做"显示出来,不是静默跳过。

import { needsAttention, type CellState } from "./deployments-shared";

/** 矩阵里会出现的行类型(与 `MATRIX_COVERED` 同源,由门禁比对)。 */
export type MatrixRowType = "etl-job" | "code-table" | "model-table";

/** 行分组:任务(下发台账)/ 建模产物(落地观测)。呈现上混排,但处置通道完全不同。 */
export type MatrixRowGroup = "task" | "modeling";

export interface MatrixActionRow {
  type: string;
  id: string;
  group?: MatrixRowGroup;
  /** 任务行重发要用它的 cron(没有 cron 就没有可下发的调度) */
  cronExpression?: string;
}

export type MatrixAction =
  | { kind: "post"; endpoint: string; body: Record<string, unknown>; label: string }
  /** 🔴 不做,并且**说清为什么**(静默跳过 = 用户以为已经处理了) */
  | { kind: "skip"; reason: string };

/**
 * 一个 (行 × target × 状态) 该怎么处置。
 *
 * 🔴 判定顺序即语义:先"要不要处置"(免判态一律 skip)→ 再"能不能一键处置"(drift 不能)
 * → 最后才按类型选端点。顺序反了就会出现"给一个 ⊘ 缺写入通道的格子发一次落地"(白跑 + 误导)。
 */
export function matrixRepublishAction(row: MatrixActionRow, targetId: string, state: CellState): MatrixAction {
  if (!needsAttention(state)) {
    return { kind: "skip", reason: `该格状态是 ${state},不属于「需要处理」⇒ 不动它(免判态按了也没用)` };
  }
  if (state === "drift") {
    return {
      kind: "skip",
      reason:
        "drift 需要人工决定是否**以平台定义强制重建** —— 那会 DROP 该区现有表、表里的数据一起消失。" +
        "⇒ 看板刻意不提供一键处置,请去建模页落地面板逐字确认(FORCE-REBUILD)。",
    };
  }
  switch (row.type) {
    case "etl-job":
      if (!row.cronExpression) {
        return { kind: "skip", reason: "该任务没有 cron 表达式,先去作业页设置调度再重发" };
      }
      return {
        kind: "post",
        endpoint: `/api/etl-jobs/${row.id}/schedule`,
        body: { cronExpression: row.cronExpression, targets: [targetId] },
        label: "重发到此 region",
      };
    case "code-table":
      return {
        kind: "post",
        endpoint: `/api/modeling/codetables/${row.id}/land`,
        body: { targets: [targetId] },
        label: "落地到此 region",
      };
    case "model-table":
      return {
        kind: "post",
        endpoint: `/api/modeling/dimensions/${row.id}/apply`,
        body: { targets: [targetId] },
        label: "落地到此 region",
      };
    default:
      // 🔴 **绝不回落到任务端点**:那等于拿一个别的资源的 id 去调调度接口(轻则 404,重则乱发 DAG)。
      return { kind: "skip", reason: `未知资源类型 ${row.type}:没有已登记的下发通道 ⇒ 刻意不猜,不回落到任务调度端点` };
  }
}

/**
 * 读处置结果。🔴 **HTTP 200 不等于那一格现在是绿的**。
 *
 * 建模落地端点在 `drift` / `credential-gap` 这些情形下**也回 200**
 * (它成功地"记下了观测到的事实"),任务下发端点则在逐 target 结果里带 `status:"failed"`。
 * ⇒ 只看 HTTP 码就报"已处置"是**界面层的假绿**,必须读回真实的逐 target 结果。
 */
export function readMatrixActionResult(
  row: MatrixActionRow,
  targetId: string,
  data: unknown
): { ok: boolean; note: string } {
  const d = (data ?? {}) as Record<string, any>;
  if (row.type === "etl-job") {
    const rows: Array<Record<string, any>> = Array.isArray(d.rows) ? d.rows : [];
    const mine = rows.find((x) => x?.targetId === targetId);
    if (!mine) return { ok: false, note: "下发结果里没有这个 region 的记录(无法确认是否真发了)" };
    return mine.status === "ok"
      ? { ok: true, note: `已重发 → ${mine.dagId || "(无产物名)"}` }
      : { ok: false, note: String(mine.error || "重发未成功") };
  }
  const rec = ((d.landedByTarget ?? {}) as Record<string, any>)[targetId];
  if (!rec) return { ok: false, note: "落地结果里没有这个 region 的观测记录(无法确认是否真落了)" };
  return rec.status === "ok"
    ? { ok: true, note: `已落地 → ${rec.table || "(无表名)"}` }
    : { ok: false, note: `观测态 ${rec.status}${rec.error ? `:${rec.error}` : ""}` };
}
