// 模块 43-A — reconcile-on-read 沉淀路径(零侵入模块25)。设计 §6.1 认可的退路,也是 A.1 的
// 主沉淀入口:扫 bgp-diagnostics 中 done 的记录,对每条调 recordIncident(幂等,靠 diagnosticId
// 去重)。由 /api/incidents 列表与 /api/incidents/health 在读时触发一次(轻量、限流),让"知识
// 资产从 0 到 1"无需改诊断主流程即可发生。升 AgentCore(A.2)后可改为诊断完成即时 hook。

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type { Diagnostic } from "@/lib/diagnostics/service";
import { recordIncident } from "./record";

// 最近多少条 done 诊断参与补记(低频低量;诊断表单分区,Query 逆序取头部即最新)。
const RECONCILE_SCAN_LIMIT = 200;

export interface ReconcileResult {
  scanned: number;
  recorded: number;
  skipped: number;
}

// 扫最近的 done 诊断,逐条补记(幂等)。projectId 过滤在内存做(诊断表单分区)。
// 失败个别条目不阻断整体(best-effort);沉淀是"锦上添花",绝不能因它让列表页报错。
export async function reconcileIncidents(projectId: string): Promise<ReconcileResult> {
  let scanned = 0;
  let recorded = 0;
  let skipped = 0;

  try {
    const { Items = [] } = await docClient.send(
      new QueryCommand({
        TableName: TABLES.DIAGNOSTICS,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "diagnostic" },
        ScanIndexForward: false, // ULID 逆序 → 最新在前
        Limit: RECONCILE_SCAN_LIMIT,
      })
    );
    const dones = (Items as Diagnostic[]).filter((d) => d.status === "done" && d.projectId === projectId);
    for (const d of dones) {
      scanned++;
      try {
        const r = await recordIncident(d);
        if (r.recorded) recorded++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
  } catch {
    /* 诊断表读失败不阻断列表(返回已扫计数) */
  }

  return { scanned, recorded, skipped };
}
