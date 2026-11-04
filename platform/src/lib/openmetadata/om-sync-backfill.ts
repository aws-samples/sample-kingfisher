// 🔴🔴 **同步成功后的 OM 回填** —— 「回填什么、回填到哪个 service」的**唯一作者**。
//
// 【为什么】同步跑完,目标表才有真实列;此时要把真实列写进 OM(替换 `_row` 占位),再用真实列重推一次
//   列级血缘(全表同步没有字段映射,只能按同名列派生)。原来 start 路由里写死四个**主控区口径**的回填
//   (读主控区数仓 / 主控区表桶 / 重放全部主控区任务 / 计算血缘),于是用 `if (landing.home)` 把非主控区整段跳过
//   (登记 o4-REG:非主控区同步的 schema / 列级血缘在 OM 里没有)。
//
// 【现在】路由只调这一个函数,不再自己判区:
//   · 主控区:**原来那四个,原顺序原调用**(逐字节等价;存量行为零变化);
//   · 其它区:**只回填这一个任务**、只在**该区**取真实列(数仓走 `introspectSchema(该区 workgroup, 该区库, {targetId, project})`,
//     湖走 `introspectS3Tables(namespace, {targetId})`),写进该区的 per-target service,再用 `syncOmCoords`
//     同一份坐标重推这一个任务的血缘。计算血缘回填**不做**:它重放的是主控区口径的计算边(`computeFqnToOm`),
//     与「这个区的这次同步」无关 —— 拿它跑一遍只会把主控区的边再推一次。
// 【失败】best-effort(元数据旁路绝不影响同步成功态),但**不许静默**:每一步的失败进返回值并打日志。
import type { DataSource } from "@/types/datasource";
import { syncOmCoords, syncOmPlaceIsHome, type SyncOmPlace } from "@/lib/openmetadata/om-sync-coords";

export interface SyncOmBackfillReport {
  mode: "home" | "target";
  targetId: string;
  /** 写进 OM 的真实列表数(数仓 / 湖)。主控区走原回填,不在这里计数 ⇒ null。 */
  rsTables: number | null;
  s3Tables: number | null;
  /** 血缘是否重推过。 */
  lineageRepushed: boolean;
  errors: Array<{ step: string; error: string }>;
}

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 300);
}

export async function backfillSyncOmAfterSuccess(
  task: Record<string, any>,
  ds: DataSource,
  place: SyncOmPlace
): Promise<SyncOmBackfillReport> {
  const report: SyncOmBackfillReport = {
    mode: syncOmPlaceIsHome(place) ? "home" : "target",
    targetId: place.targetId,
    rsTables: null,
    s3Tables: null,
    lineageRepushed: false,
    errors: [],
  };
  const om = await import("@/lib/openmetadata/om-push");

  if (report.mode === "home") {
    // ── 主控区:改动前 start 路由里的四个回填,原顺序原调用 ──
    const { repushSyncLineageToOM, backfillComputeLineageToOM } = await import("@/lib/governance/lineage-service");
    await om.pushRedshiftSchemaToOpenMetadata().catch(() => {});
    await om.pushS3TablesSchemaToOpenMetadata().catch(() => {});
    await repushSyncLineageToOM().catch(() => {}); // sync 边列级(用真实列重算 identity)
    await backfillComputeLineageToOM().catch(() => {}); // compute 边列级(shared-column)
    report.lineageRepushed = true;
    return report;
  }

  const { isOmConfigured } = await import("@/lib/openmetadata/om-client");
  if (!isOmConfigured()) return report;

  let c: ReturnType<typeof syncOmCoords>;
  try {
    c = syncOmCoords(task, ds, place);
  } catch (e) {
    report.errors.push({ step: "coords", error: errText(e) });
    console.error("[om-sync-backfill] %s 落点不全,不回填:%s", place.targetId, errText(e));
    return report;
  }
  const wantedTargets = new Set(c.tables.map((t) => t.target));

  // ① 该区数仓里这个任务目标表的真实列
  if (c.writeRs) {
    try {
      const { introspectSchema } = await import("@/lib/genbi/schema");
      const projectId = typeof task.projectId === "string" && task.projectId ? task.projectId : null;
      const all = await introspectSchema(place.rsWorkgroup || "", place.rsDatabase || "", { targetId: place.targetId, project: projectId });
      const mine = all.filter((t) => t.schema.toLowerCase() === c.rsSchema && wantedTargets.has(t.table.toLowerCase()));
      await om.ensureService(c.services.rs, om.customDbService(c.services.rs));
      await om.putDatabase(c.rsDb, c.services.rs);
      await om.putSchema(c.rsSchema, `${c.services.rs}.${c.rsDb}`);
      for (const t of mine) {
        await om.putTable(t.table.toLowerCase(), c.rsSchemaFqn, t.columns.map((x) => ({ name: x.name, type: x.type })));
      }
      report.rsTables = mine.length;
      // 🔴 空结果 ≠ 成功:同步刚成功而该区数仓里一张目标表都没读到 ⇒ 坐标(库 / schema / 表名)与真实写入对不上
      if (mine.length === 0 && wantedTargets.size > 0) {
        report.errors.push({ step: "redshift-columns", error: `该区数仓 ${c.rsDb}.${c.rsSchema} 里没读到任何目标表(${Array.from(wantedTargets).join(",")})` });
      }
    } catch (e) {
      report.errors.push({ step: "redshift-columns", error: errText(e) });
    }
  }

  // ② 该区表桶里这个任务目标表的真实列
  if (c.writeS3) {
    try {
      const { introspectS3Tables } = await import("@/lib/genbi/athena");
      const all = await introspectS3Tables(c.namespace, { targetId: place.targetId });
      const mine = all.filter((t) => wantedTargets.has(t.table));
      await om.ensureService(c.services.s3t, om.customDbService(c.services.s3t));
      await om.putDatabase(c.bucket, c.services.s3t);
      await om.putSchema(c.namespace, `${c.services.s3t}.${c.bucket}`);
      for (const t of mine) {
        await om.putTable(t.table, c.s3SchemaFqn, t.columns.map((x) => ({ name: x.name, type: x.type })));
      }
      report.s3Tables = mine.length;
      if (mine.length === 0 && wantedTargets.size > 0) {
        report.errors.push({ step: "s3tables-columns", error: `该区表桶 namespace ${c.namespace} 里没读到任何目标表(${Array.from(wantedTargets).join(",")})` });
      }
    } catch (e) {
      report.errors.push({ step: "s3tables-columns", error: errText(e) });
    }
  }

  // ③ 用真实列重推这一个任务的列级血缘(同一份坐标)
  try {
    await om.pushSyncToOpenMetadata(task, ds, place);
    report.lineageRepushed = true;
  } catch (e) {
    report.errors.push({ step: "lineage", error: errText(e) });
  }

  if (report.errors.length) {
    console.error(
      "[om-sync-backfill] %s 回填有失败:%s",
      place.targetId,
      report.errors.map((x) => `${x.step}: ${x.error}`).join(" | ")
    );
  }
  return report;
}
