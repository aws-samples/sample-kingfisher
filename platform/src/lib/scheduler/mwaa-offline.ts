// 调度下线(offline)共享助手 —— 把一个已发布的 DAG 从 **该 target 的** MWAA 彻底撤下:
//   ① Airflow CLI `dags pause`(立即停止后续调度触发;文件删除后 30~60s 才会从 UI 消失,先 pause 保证窗口期内不再多跑一次);
//   ② 删除**该区** DAG 桶上的 DAG 文件(MWAA 扫描周期后自动从 Airflow 移除该 DAG)。
// ETL 作业调度 / EMR 引擎调度 / workflow 编排三处复用;幂等(pause 失败 / 文件不存在都不阻断)。
//
// @kf-batch 50-WP13-mwaa-region
// 🔴 原版只删 home 桶 / pause home 环境(50 SPEC §3.12 点名的「非 home 孤儿调度」):非 home 的 DAG 现在落在**该 target 自己的**
//    Airflow(§3.14),下线也必须去那一套。签名 `offlineDag(dagId, targetId = tgt_home)` = SPEC §3.12 的合同形态;缺省 home ⇒
//    存量调用方(workflow unpublish)逐字节不变。该 target 已无 MWAA(理论上只在删除流程中途出现)⇒ 如实回 `skipped`,不去 home 乱删。
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3ClientFor } from "@/lib/exec-env/target-clients";
import { MwaaNotInstalled, mwaaCli, mwaaEndpointFor } from "@/lib/scheduler/mwaa-endpoint";

export interface OfflineResult {
  dagId: string;
  targetId: string;
  paused: boolean; // Airflow pause 是否成功(尽力而为)
  dagFileDeleted: boolean; // 该区 DAG 文件删除是否成功
  /** 该 target 没有 MWAA 可下线时的原因(不算错误:没有东西可撤) */
  skipped?: string;
}

/** 把 DAG 从**该 target 的** MWAA 下线:pause(尽力) + 删该区桶 DAG 文件(权威)。 */
// 🔴🔴 @kf-batch 50-WP17-serverless-workflow —— **`targetId` 由「有默认值」改成「必填」**。
//   根治的是一整类缺陷(2026-09-11 一天里在六个地方各犯一次):「落点」是个**有静默合法默认值**的参数,
//   漏传不报错、只是**在错的区域干活**。WP-13 当时给的 `= HOME_TARGET_ID` 本意是「存量逐字节不变」,
//   而 WP-4quater 把工作流变成 per-target 之后,这个默认值就成了洞(unpublish 路由正是这么中的)。
//   删掉默认值 ⇒ 漏传变成**编译错误**,由类型系统去枚举调用点,而不是靠我 grep 记全。
export async function offlineDag(dagId: string, targetId: string): Promise<OfflineResult> {
  let ep;
  try {
    ep = await mwaaEndpointFor(targetId);
  } catch (e) {
    if (e instanceof MwaaNotInstalled) {
      return { dagId, targetId, paused: false, dagFileDeleted: false, skipped: e.missing[0]?.reason ?? "该执行环境没有 MWAA" };
    }
    throw e;
  }

  // ① pause:立即停调度(DAG 文件删除有扫描延迟,pause 兜住窗口期)。失败不阻断 —— 文件删除后 MWAA 自会移除 DAG。
  let paused = false;
  try {
    paused = (await mwaaCli(ep, `dags pause ${dagId}`)).ok;
  } catch {
    /* best-effort */
  }

  // ② 删 DAG 文件(权威动作):该区 MWAA 下个扫描周期把 DAG 从 Airflow 移除。
  let dagFileDeleted = false;
  try {
    const s3 = await s3ClientFor(ep.region);
    await s3.send(new DeleteObjectCommand({ Bucket: ep.dagBucket, Key: `dags/${dagId}.py` }));
    dagFileDeleted = true;
  } catch {
    /* 文件不存在视为已下线 */
  }

  return { dagId, targetId, paused, dagFileDeleted };
}
