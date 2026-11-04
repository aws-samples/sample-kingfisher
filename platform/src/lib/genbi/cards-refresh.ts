// (问数 · CAP-GENBI)
// 🔴🔴 **问数卡片刷新的唯一作者** —— 「立即刷新」(页面)与「定时刷新」(平台动作)共用这一个函数。
//
// 【定的是什么(用户 2026-10-10 默认方案,可改)】刷新**同一张**卡片 + 保留运行快照历史(不占 100 张额度)。
//   原判据「每次产出一张新卡片」会把 100 张额度吃满 —— 已同步修订合同文字。
//
// 【做什么 —— 不调大模型,只重跑卡片里存下的那条只读 SQL】
//   读指针 → requireReadyTarget(要在那个区**跑**)→ 读该区正文取 turns[i].result.sql
//   → runSelect / runSelectAthena(落点 = 卡片自己的区)→ maskRows(identity=null **最严**)
//   → suggestChart → 驻留审计(手动 = 用户身份;定时 = 服务身份,且只放行作者同意过的跨法域 target)
//   → 正文原地改写 + 快照写该区 S3(runs/<id>.json + latest.json)→ 中央指针盖非数据戳
//   → 手动那次写 run 台账(taskType=genbi-card;定时那次由 DAG 的 __start/__finish 收口,不重复写)。
//
// 【为什么脱敏一律用最严口径】刷新结果会**写回卡片**(之后任何时候打开都能看到),而定时那次根本没有「看的人」;
//   用调用者身份脱敏就会出现「管理员点了一次刷新,卡片里从此存着明文」。打开卡片时仍会按当时的分级再取更严者。
// 【文字结论不重写】answer 是保存时大模型写的;刷新只换数据 ⇒ 结果上带 `refreshedAt`,页面据此提示「数据已刷新,文字结论来自保存时」。
import { ulid } from "ulid";
import { requireReadyTarget } from "@/lib/exec-env/registry";
import { residencyAudit, scheduledResidencyAudit, userActor } from "@/lib/exec-env/residency-audit";
import { maskRows } from "@/lib/governance/masking";
import { putRunRecord } from "@/lib/monitor/run-records";
import type { Identity } from "@/lib/auth/identity";
import { GENBI } from "@/lib/genbi/config";
import { runSelect } from "@/lib/genbi/redshift";
import { runSelectAthena } from "@/lib/genbi/athena";
import { suggestChart } from "@/lib/genbi/chart";
import {
  CARD_REFRESH_SNAPSHOT_KEEP,
  getCardPointer,
  stampCardRefresh,
  stampCardRefreshFailed,
} from "@/lib/genbi/cards-store";
import {
  CARD_BODY_VERSION,
  deleteCardRunSnapshot,
  getCardBody,
  putCardBody,
  putCardRunSnapshot,
  type CardRunSnapshot,
} from "@/lib/genbi/cards-body-store";
import { CardNotFound, CardStoreUnavailable } from "@/lib/genbi/cards-service";

/** 卡片里没有可重跑的 SQL(纯文字回答 / 那一轮失败了)⇒ 拒,**不报成功**。 */
export class CardNotRefreshable extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "CardNotRefreshable";
  }
}

/** 重跑 SQL 失败(数仓报错 / 表没了 / 超时)。真因原样带出。 */
export class CardRefreshFailed extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "CardRefreshFailed";
  }
}

/** 卡片定时刷新的调度对象 id(run 台账的 taskId 也是它:手动与定时的历史在同一条 taskId 下)。 */
export function cardScheduleTaskId(cardId: string): string {
  return `gcard_${cardId}`;
}

export type CardRefreshActor =
  | { kind: "user"; identity: Identity }
  | { kind: "schedule"; authorSub: string };

export interface RefreshCardOptions {
  triggeredBy: "manual" | "schedule";
  actor: CardRefreshActor;
  /** 刷新哪一轮;缺省 = 最后一个带 SQL 的轮次(显式参数,不是静默默认:见 `pickTurn`)。 */
  turnIndex?: number;
}

export interface RefreshCardResult {
  cardId: string;
  snapshotId: string;
  turnIndex: number;
  refreshedAt: string;
  rowCount: number;
  columns: number;
  maskedColumns: string[];
  targetId: string;
}

/** 选轮次:点名了就必须存在且有 SQL;没点名 ⇒ 最后一个带 SQL 的轮次。纯函数。 */
export function pickTurn(turns: Array<{ result: Record<string, unknown> | null }>, turnIndex?: number): { idx: number; sql: string } {
  const sqlOf = (i: number) => {
    const r = turns[i]?.result as { sql?: unknown } | null | undefined;
    return typeof r?.sql === "string" && r.sql.trim() ? r.sql.trim() : "";
  };
  if (turnIndex !== undefined) {
    if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= turns.length) {
      throw new CardNotRefreshable(`这张卡片没有第 ${turnIndex + 1} 轮(共 ${turns.length} 轮)`);
    }
    const sql = sqlOf(turnIndex);
    if (!sql) throw new CardNotRefreshable(`第 ${turnIndex + 1} 轮没有可重跑的 SQL(纯文字回答或那一轮失败了)`);
    return { idx: turnIndex, sql };
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const sql = sqlOf(i);
    if (sql) return { idx: i, sql };
  }
  throw new CardNotRefreshable("这张卡片里没有任何一轮带 SQL —— 没有可刷新的数据(纯文字回答不能刷新)");
}

export async function refreshCardOnce(userSub: string, cardId: string, opts: RefreshCardOptions): Promise<RefreshCardResult> {
  const startedAt = new Date();
  const snapshotId = ulid();
  const pointer = await getCardPointer(userSub, cardId);
  if (!pointer || pointer.state !== "ready") throw new CardNotFound(cardId);
  const runStamp = { projectId: pointer.projectId, targetId: pointer.targetId };
  const ledger = async (status: "succeeded" | "failed", extra: Record<string, unknown>) => {
    // 🔴 只给**手动**那次写台账:定时那次的行由 DAG 的 __start/__finish 收口(同一 taskId),写两次就是两行
    if (opts.triggeredBy !== "manual") return;
    await putRunRecord({
      taskId: cardScheduleTaskId(cardId),
      runId: snapshotId,
      taskType: "genbi-card",
      stamp: runStamp,
      status,
      startedAt: startedAt.toISOString(),
      triggeredBy: "manual",
      extra: {
        finishedAt: new Date().toISOString(),
        duration: Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000)),
        taskTargetKey: `${cardScheduleTaskId(cardId)}#${pointer.targetId}`,
        snapshotId,
        ...extra,
      },
    }).catch((e) => console.error("[genbi/cards-refresh] 手动刷新写台账失败:%s", String(e)));
  };

  try {
    // ① 要在那个区**跑** ⇒ 必须可承接(fail-closed;不可承接就抛,绝不回落主控区)
    const target = await requireReadyTarget(pointer.targetId);
    // ② 该区正文
    const body = await getCardBody(target, userSub, cardId);
    if (!body) throw new CardStoreUnavailable("这张卡片的正文已不在该区域,无法刷新(可以删掉它释放额度)");
    const { idx, sql } = pickTurn(body.turns, opts.turnIndex);
    // ③ 驻留审计(跨法域才真写;home / 同法域零 I/O)
    if (opts.actor.kind === "user") {
      await residencyAudit({
        actor: userActor(opts.actor.identity),
        targetId: pointer.targetId,
        entry: "execute",
        triggeredBy: "genbi-card-refresh",
        projectId: pointer.projectId,
        sqlText: sql,
      });
    } else {
      await scheduledResidencyAudit({
        onBehalfOfSub: opts.actor.authorSub,
        targetId: pointer.targetId,
        entry: "execute",
        triggeredBy: "genbi-card-refresh-schedule",
        projectId: pointer.projectId,
        sqlText: sql,
      });
    }
    // ④ 重跑(落点 = 卡片自己的区;Redshift 的库名用正文里存下的那个)
    const database = body.database || GENBI.database;
    const run = pointer.engine === "athena"
      ? await runSelectAthena(sql, { targetId: pointer.targetId })
      : await runSelect(sql, "", database, { targetId: pointer.targetId, project: pointer.projectId });
    if (!run.success) throw new CardRefreshFailed(`重跑卡片里的 SQL 失败:${run.error || "未知原因"}`);
    // ⑤ 最严口径脱敏(identity=null)+ 图表建议
    const masked = await maskRows({ columns: run.columns.map((name) => ({ name })), rows: run.rows, sql, database, identity: null });
    const rows = masked.rows as (string | null)[][];
    const chart = suggestChart(run.columns, rows);
    const refreshedAt = new Date().toISOString();
    // ⑥ 正文原地改写(同一张卡;只换数据,文字结论保持保存时的样子并打上 refreshedAt)
    const prev = (body.turns[idx].result || {}) as Record<string, unknown>;
    body.turns[idx] = {
      ...body.turns[idx],
      result: {
        ...prev,
        columns: run.columns,
        rows,
        rowCount: run.rowCount,
        chart,
        maskedColumns: masked.maskedColumns,
        refreshedAt,
        refreshSnapshotId: snapshotId,
      },
    };
    const put = await putCardBody(target, userSub, body);
    // ⑦ 快照(该区 S3)
    const snap: CardRunSnapshot = {
      v: CARD_BODY_VERSION, cardId, snapshotId, turnIndex: idx, refreshedAt, triggeredBy: opts.triggeredBy,
      sql, columns: run.columns, rows, rowCount: run.rowCount, chart, maskedColumns: masked.maskedColumns,
    };
    await putCardRunSnapshot(target, userSub, snap);
    // ⑧ 中央指针(非数据戳)+ 快照保留份数
    const list = [snapshotId, ...(pointer.refreshSnapshots ?? [])];
    const keep = list.slice(0, CARD_REFRESH_SNAPSHOT_KEEP);
    const drop = list.slice(CARD_REFRESH_SNAPSHOT_KEEP);
    try {
      await stampCardRefresh(userSub, cardId, {
        bytes: put.bytes, bodySha256: put.sha256, refreshedAt, snapshotId, snapshots: keep,
        refreshCount: (pointer.refreshCount ?? 0) + 1,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
        // 刷新途中卡片被删 ⇒ 刚写的快照是孤儿:当场删掉(正文由删卡那条路负责)
        await deleteCardRunSnapshot(target, userSub, cardId, snapshotId);
        throw new CardNotFound(cardId);
      }
      throw e;
    }
    for (const old of drop) await deleteCardRunSnapshot(target, userSub, cardId, old);
    await ledger("succeeded", { rowCount: run.rowCount });
    return {
      cardId, snapshotId, turnIndex: idx, refreshedAt, rowCount: run.rowCount, columns: run.columns.length,
      maskedColumns: masked.maskedColumns, targetId: pointer.targetId,
    };
  } catch (e) {
    if (!(e instanceof CardNotFound)) {
      await stampCardRefreshFailed(userSub, cardId).catch(() => {});
      await ledger("failed", { error: String((e as Error)?.message ?? e).slice(0, 500) });
    }
    throw e;
  }
}
