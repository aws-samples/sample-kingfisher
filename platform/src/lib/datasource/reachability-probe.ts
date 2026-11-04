// 序 49 ② B-73 —— 「这个数据源现在连得上吗」的**唯一作者**:状态格的「已连接」只许来自真正连上的结论。
//
// 【缺陷原形(B-73,s38 负向源 10.255.255.1)】建源收口与「测试连接(按 id)」都拿 `testConnection(glueConnectionName)`
//   的结论写 `status`:那只核「Glue 连接存在 + 带 JDBC URL + 带子网」,不登录源库 ⇒ host 根本不可达的源建完就显示
//   「已连接 (115ms)」(115ms 是查 Glue 连接配置的耗时),直到有人点「检测」才露馅。工程纪律 9:不许把「配置建好了」说成「已连接」。
// 【规则】
//   ① 配置核对(`testConnection`)只回答「Glue 连接配好了没」:没配好 ⇒ status=error(真的配错了);配好了 ⇒ **不改 status**,
//      接着走 ②,把结论交给真正的连通性检测。
//   ② 连通性检测 = 「检测」按钮那一条(原样搬自 heartbeat POST,行为逐字不变):probeVia=auto 先控制面直连;
//      直连可达 ⇒ active;直连不到且有 Glue 连接 ⇒ 起(或复用)一次发现作业当探测,status=testing,
//      结论由 `glue-probe-settle` 在列表 / 单条 / 轮询读到时推进(成功 active · 失败 unreachable · 无结果 error)。
//   ③ 探测本身发不起来(例:没填数据库名)⇒ status=error + 心跳里写明原因 —— 绝不停在「测试中」没人推进。
import { pingDataSource } from "@/lib/datasource/heartbeat";
import { dsCanUseGlueReach, dsProbeVia, startGlueProbe, glueReachNote, type GlueProbeStart } from "@/lib/datasource/glue-reach";
import { patchDataSourceRow } from "@/lib/datasource/ds-patch";
import { DatasourceNetworkBrokenError } from "@/lib/datasource/network-reconcile";
// 序 31 二刀 ⑤:心跳直连读凭证(secret ARN 自带区)/ 起探测作业都替这条源所在区做事 ⇒ 入口先记落点决策
import { noteDatasourceRowPlace } from "@/lib/datasource/ds-place";
import type { TestResult } from "@/lib/aws/datasource-service";
import type { DataSource } from "@/types/datasource";

type Hb = NonNullable<DataSource["heartbeat"]>;
type ControlPlaneResult = { reachable: boolean | null; latencyMs?: number; error?: string };

export type ReachabilityOutcome =
  /** 已有结论(控制面直连可达 / 不可达且没有 Glue 连接可兜 / 该类型不支持探活 ⇒ status 原样) */
  | { kind: "settled"; status: string; hb: Hb; cp: ControlPlaneResult }
  /** 已改经数据源自己的 Glue 连接探测(发现作业在跑),结论稍后由 glue-probe-settle 推进 */
  | { kind: "glue-testing"; status: "testing"; hb: Hb; probe: GlueProbeStart; message: string }
  /** 配置核对没过(Glue 连接缺 / 没 JDBC URL / 没子网):真的配错了 */
  | { kind: "config-failed"; status: "error"; testResult: TestResult & { testedAt: string } }
  /** 探测发不起来 ⇒ 如实记 error,不留在「测试中」 */
  | { kind: "probe-failed"; status: "error"; hb: Hb; error: string };

async function writeHeartbeat(datasourceId: string, status: string, hb: Hb) {
  await patchDataSourceRow(datasourceId, { status, lastHeartbeatAt: hb.at, heartbeat: hb });
}

/**
 * 「检测」—— 连通性检测本体(heartbeat POST 与建源收口共用)。写库并返回结论。
 * 🔴 行为与 B-70 第 2 版 heartbeat POST 逐字相同(搬家不改语义;glue-reach-routes 判据守着)。
 */
export async function probeDataSourceReachability(row: DataSource, now: string = new Date().toISOString()): Promise<
  Extract<ReachabilityOutcome, { kind: "settled" | "glue-testing" }>
> {
  noteDatasourceRowPlace(row);
  const viaGlue = dsCanUseGlueReach(row) && dsProbeVia(row) === "glue-connection";
  let cp: ControlPlaneResult | null = null;
  if (!viaGlue) {
    // 行来自 DDB(原 heartbeat 路由按 any 传);非 JDBC 范式没有 host 等字段,由 pingDataSource 自己按类型判「不支持」
    cp = await pingDataSource({
      type: row.type, host: row.host, port: row.port, database: row.database,
      username: row.username, secretArn: row.secretArn,
    } as Parameters<typeof pingDataSource>[0]);
    // 直连可达 / 该范式不支持探活 ⇒ 存量语义逐字不变(active / 不改状态)
    if (cp.reachable !== false || !dsCanUseGlueReach(row)) {
      const status = (cp.reachable === null ? row.status : cp.reachable ? "active" : "unreachable") as string;
      const hb: Hb = { reachable: cp.reachable, latencyMs: cp.latencyMs ?? null, error: cp.error ?? null, at: now, via: "control-plane", state: "settled" };
      await writeHeartbeat(row.datasourceId, status, hb);
      return { kind: "settled", status, hb, cp };
    }
  }
  // 控制面直连不到(或源声明在自有网络)⇒ 经数据源自己的 Glue 连接探测(= 发现作业)
  let probe: GlueProbeStart;
  try {
    probe = await startGlueProbe(row as never, (patch) => patchDataSourceRow(row.datasourceId, patch));
  } catch (e) {
    // 序 61 B-133:源的用户自带安全组 / 子网或密钥缺失(平台不代建)⇒ 发现作业根本起不来 ⇒ 心跳如实「不可达 + 原因」、状态 error;
    //   不冒成 500(「检测」按钮)也不留在「测试中」;源行的 networkState / networkIssue 已由核对作者写好,列表显示「网络对象缺失」。
    if (e instanceof DatasourceNetworkBrokenError) {
      const hb: Hb = {
        reachable: false, latencyMs: null, error: e.message, at: now, via: "glue-connection", state: "settled",
        controlPlane: cp ? { reachable: cp.reachable, error: cp.error ?? null } : { reachable: null, error: "按数据源设置跳过控制面直连(源在自有网络)" },
      };
      await writeHeartbeat(row.datasourceId, "error", hb);
      return { kind: "settled", status: "error", hb, cp: cp ?? { reachable: null, error: e.message } };
    }
    throw e;
  }
  const hb: Hb = {
    reachable: null, latencyMs: null, error: null, at: now, via: "glue-connection", state: "testing", startedAt: probe.startedAt, jobRunId: probe.jobRunId,
    controlPlane: cp ? { reachable: cp.reachable, error: cp.error ?? null } : { reachable: null, error: "按数据源设置跳过控制面直连(源在自有网络)" },
  };
  await writeHeartbeat(row.datasourceId, "testing", hb);
  return { kind: "glue-testing", status: "testing", hb, probe, message: glueReachNote("probe", cp?.error) };
}

/**
 * 配置核对之后的收口(建源 / 「测试连接(按 id)」共用):
 *   配置没过 ⇒ error + testResult;配置过了 ⇒ 只记 testResult,status 交给 `probeDataSourceReachability`;
 *   探测发不起来 ⇒ error + 心跳写明原因。
 */
export async function settleAfterConfigCheck(row: DataSource, result: TestResult): Promise<ReachabilityOutcome> {
  noteDatasourceRowPlace(row);
  const testedAt = new Date().toISOString();
  const testResult = { ...result, testedAt };
  if (!result.success) {
    await patchDataSourceRow(row.datasourceId, { status: "error", testResult });
    return { kind: "config-failed", status: "error", testResult };
  }
  await patchDataSourceRow(row.datasourceId, { testResult });
  try {
    return await probeDataSourceReachability(row);
  } catch (e) {
    const error = `连通性检测没能发起:${String((e as Error)?.message || e).slice(0, 300)}`;
    const hb: Hb = { reachable: null, latencyMs: null, error, at: new Date().toISOString(), state: "unknown" };
    await writeHeartbeat(row.datasourceId, "error", hb);
    return { kind: "probe-failed", status: "error", hb, error };
  }
}
