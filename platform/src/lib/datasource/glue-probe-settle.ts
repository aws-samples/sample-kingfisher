// 序 38 B-70 —— 把「经 Glue 连接验证中」的数据源行推进到结论(唯一作者)。
//   三个消费面:GET /api/datasources(列表)· GET /api/datasources/[id](单条)· GET /api/datasources/[id]/heartbeat(页面轮询)。
//   为什么列表 / 单条也要推进:探测是异步的 Glue 作业(1–3 分钟),用户点完「检测」换页 / 刷新后页面不再轮询,
//   若只有 heartbeat GET 会落结论,那一行会永远停在「测试中」。读到就推进,谁来看都能看到结论。
//   不在 testing 态的行原样返回、零外部调用;推进失败(Glue 读不到 / 落库失败)不影响读取本身 —— 原样返回。
import { readGlueProbe, type GlueReachDs } from "@/lib/datasource/glue-reach";
import { patchDataSourceRow } from "@/lib/datasource/ds-patch";
import type { DataSource } from "@/types/datasource";

type Hb = NonNullable<DataSource["heartbeat"]>;

export function isGlueProbePending(row: Pick<DataSource, "heartbeat">): boolean {
  const hb = row.heartbeat;
  return !!hb && hb.via === "glue-connection" && hb.state === "testing" && !!hb.startedAt;
}

/** 推进一行;返回推进后的行(可能与入参相同)。 */
export async function settleGlueProbeRow<T extends DataSource>(row: T): Promise<T> {
  if (!isGlueProbePending(row)) return row;
  const hb = row.heartbeat as Hb & { startedAt: string };
  const persist = (patch: Record<string, unknown>) => patchDataSourceRow(row.datasourceId, patch);
  const r = await readGlueProbe(row as unknown as GlueReachDs, hb, persist);
  if (r.state === "testing") return row;
  const now = new Date().toISOString();
  const next: Hb = r.state === "settled"
    ? { ...hb, reachable: r.reachable, error: r.reachable ? null : r.reason ?? null, state: "settled", validatedAt: r.validatedAt, at: now }
    : { ...hb, reachable: null, error: r.reason, state: "unknown", at: now };
  const status = r.state === "settled" ? (r.reachable ? "active" : "unreachable") : "error";
  await persist({ status, lastHeartbeatAt: now, heartbeat: next });
  return { ...row, status, lastHeartbeatAt: now, heartbeat: next };
}

/** 列表版:只对「验证中」的行发调用;任一行推进失败就保留原行(不让一行拖垮整张列表)。 */
export async function settleGlueProbeRows<T extends DataSource>(rows: T[]): Promise<T[]> {
  return Promise.all(rows.map(async (row) => {
    if (!isGlueProbePending(row)) return row;
    try {
      return await settleGlueProbeRow(row);
    } catch (e) {
      console.warn(`[glue-probe] 数据源 ${row.datasourceId} 推进探测结论失败,先按原状态返回:${String((e as Error)?.message || e).slice(0, 160)}`);
      return row;
    }
  }));
}
