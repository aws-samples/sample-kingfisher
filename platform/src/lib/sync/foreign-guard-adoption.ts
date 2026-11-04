// @kf-batch 37-sync-capability —— 序 37 B-60 的**升级兼容**:守卫上线前已经成功运行过的同步任务,首次运行时把它当时的目标表记为已确认。
//
// 【为什么必须有它(2026-10-12 真环境核实)】测试账号上有 7 个常驻 Showcase 同步任务(overwrite · both),其 S3 Tables 表是
//   旧脚本建的、**没有**平台标记(标记 B-60 才加)。按守卫的本义,它们下一次重生成脚本就会 SYNC_REFUSED_CLEAR_FOREIGN_TABLE
//   —— 用户眼里就是「升级把原来好的功能改坏了」。而事实是:这些表正是平台自己建的、用户已经接受了每次覆盖。
//
// 【规则(只在 startGlueSyncRun 里、生成脚本之前做一次;脚本只在那里重生成,调度载体只 start_job_run 旧作业)】
//   · 条件:任务这次运行**会触发守卫**(clearsWholeTable 同一判定)且任务记录**没有** `foreignGuardAdoptedAt`;
//   · 查该任务的 run 台账里有没有至少一条 status=succeeded 的 run(既有的按 taskId 查询,listRunsByTask 单一作者);
//       有 ⇒ 守卫上线前就成功写过这些目标 = 用户已事实接受 ⇒ 一次性把**当前**目标写进任务记录:
//            overwriteConfirmedTables = 去重排序(原有 ∪ Redshift 全名 ∪ S3 三段名),同时写 foreignGuardAdoptedAt;
//       没有 ⇒ 只写 foreignGuardAdoptedAt(不收养任何表),之后不再查;
//   · 只做一次(字段存在就跳过);之后用户改了目标表名就得重新确认 —— 这是对的;
//   · 新任务(建完第一次运行,从没成功过)不收养,守卫全量生效。
// 🔴 `foreignGuardAdoptedAt` 只有服务端写(PUT 路由剔除客户端传来的这个键)。
import { listRunsByTask } from "@/lib/monitor/run-records";
import { updateSyncTaskIfExists } from "./task-write";
import { clearsWholeTable, parseConfirmedTables, redshiftTargetTables, s3TargetTables, writesRedshift, writesS3Tables, type GuardTaskShape } from "./target-table-guard";

export type AdoptionOutcome =
  | { kind: "skipped"; reason: "already-adopted" | "guard-not-triggered" | "task-gone" }
  | { kind: "stamped-only" }
  | { kind: "adopted"; tables: string[] };

/**
 * 对一条任务做一次「既有目标收养」。会**就地**改 `task`(overwriteConfirmedTables / foreignGuardAdoptedAt),
 * 让紧接着的脚本生成读到更新后的任务;同时条件写回 DDB(行已被删 ⇒ 不写、按 task-gone 返回)。
 * `ds` = 数据源行(S3 三段名的 namespace 缺省取它的库名;启动路由里恒有)。
 */
export async function adoptExistingTargetsOnce(
  task: GuardTaskShape & Record<string, unknown>,
  taskId: string,
  ds: { database?: unknown } | undefined,
  now: () => string = () => new Date().toISOString(),
): Promise<AdoptionOutcome> {
  if (typeof task.foreignGuardAdoptedAt === "string" && task.foreignGuardAdoptedAt) return { kind: "skipped", reason: "already-adopted" };
  if (!clearsWholeTable(task) || (!writesRedshift(task) && !writesS3Tables(task))) return { kind: "skipped", reason: "guard-not-triggered" };
  const runs = await listRunsByTask(taskId);
  const everSucceeded = runs.some((r) => r.status === "succeeded");
  const ts = now();
  if (!everSucceeded) {
    const r = await updateSyncTaskIfExists({
      taskId,
      UpdateExpression: "SET foreignGuardAdoptedAt = :t",
      ExpressionAttributeValues: { ":t": ts },
    });
    if (!r.ok) return { kind: "skipped", reason: "task-gone" };
    task.foreignGuardAdoptedAt = ts;
    return { kind: "stamped-only" };
  }
  const current = new Set(parseConfirmedTables(task.overwriteConfirmedTables));
  if (writesRedshift(task)) for (const fq of redshiftTargetTables(task)) current.add(fq);
  if (writesS3Tables(task)) for (const fq of s3TargetTables(task, ds)) current.add(fq);
  const tables = Array.from(current).sort();
  const r = await updateSyncTaskIfExists({
    taskId,
    UpdateExpression: "SET overwriteConfirmedTables = :c, foreignGuardAdoptedAt = :t",
    ExpressionAttributeValues: { ":c": tables, ":t": ts },
  });
  if (!r.ok) return { kind: "skipped", reason: "task-gone" };
  task.overwriteConfirmedTables = tables;
  task.foreignGuardAdoptedAt = ts;
  console.log(`SYNC_ADOPTED_EXISTING_TARGETS task=${taskId} tables=${JSON.stringify(tables)}`);
  return { kind: "adopted", tables };
}
