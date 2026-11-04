// 编排 DAG 的**执行落点**(单一作者)。
//
// 【为什么单独一个文件】工作流有**两个** DAG 生成器(冻结的 legacy 与 v2/runtime-lib),
// 「非 home 必须显式给执行面参数、缺一即拒」这条规则如果各写一遍,迟早只有一边被改
// (本仓已经吃过 publish 与 schedule/enable 两份副本漂移那一刀:Task#19)。
// ⇒ 规则只在这里写一次,两个生成器都调它。
//
// 【两个轴,别合并】
//   · `execRegion` = **干活**的区:Glue start_job_run / Redshift execute_statement 都打这里;
//   · `ctrlRegion` = **主控区**:DynamoDB 台账(`bgp-workflows` / `bgp-task-runs`)只在主控区有表。
//   用户 2026-09-10 的原话就是这个模型:「调度只能在自己的区域执行。**只是元数据收集上报到主控区而已**」。
//   合成一个 region 时,「调度在 usw2 而活儿打回主控区」这种错**不抛异常**,只是跑错了区
//   —— 对跨法域 target 即数据出境。所以两个轴必须分开命名、分开断言。

import { homeRegion } from "@/lib/place/home-region";
/** 生成 workflow DAG 时的执行面参数。非 home 时四项**都必须显式给**。 */
import type { CarrierLedger } from "@/lib/scheduler/carrier-ledger";

export interface WorkflowDagPlace {
  /** 干活的区(该工作流绑定 target 的 region);缺省 = 主控区 */
  execRegion?: string;
  /** 该 target 的数仓落点 */
  workgroup?: string;
  database?: string;
  /** 该 target 的 Redshift 凭证(含 SQL 节点时必需) */
  redshiftSecretArn?: string;
  /** 该工作流的落点;用于 fail-closed 判定与错误信息 */
  targetId?: string;
  /**
   * **这个载体的台账归属**(缺省 = 工作流自己 ⇒ 逐字节同改动前)。
   * 同步任务的定时调度复用同一套载体,但运行/发布记录要落到它自己那一行 ——
   * 不拆这个参数就会往 `bgp-workflows` upsert 出一条幽灵工作流(理由见 carrier-ledger.ts)。
   */
  ledger?: CarrierLedger;
}

export const HOME_TARGET = "tgt_home";

/** 主控区(控制面固定):台账表只在这里。 */
export function ctrlRegionOf(): string {
  return homeRegion();
}

/**
 * fail-closed:非 home 缺任一执行面参数就抛。
 * 🔴 为什么不给缺省兜底:兜底会让定时运行**静默打回主控区**,而页面上一切正常
 *    (真环境段 `scq` A2-1 抓到的就是这个形态:DAG 在 usw2 的 Airflow 里跑,正文却全是主控区的资源)。
 * @param hasSqlNode 该工作流是否含 SQL 节点(含则必须有该 target 的 SecretArn)
 */
export function assertDagPlace(workflowId: string, place: WorkflowDagPlace, hasSqlNode: boolean): void {
  const nonHome = !!place.targetId && place.targetId !== HOME_TARGET;
  if (!nonHome) return;
  if (!place.execRegion || !place.workgroup || !place.database) {
    throw new Error(
      `工作流 ${workflowId} 落点是 ${place.targetId},生成 DAG 必须显式给 ` +
        `execRegion / workgroup / database(缺省兜底会让定时运行静默打回主控区)`
    );
  }
  if (hasSqlNode && !place.redshiftSecretArn) {
    // 非 home 没有 SecretArn ⇒ DAG 里会省掉该参数、退回 MWAA worker 的联邦身份 = 属主分叉。
    throw new Error(
      `工作流 ${workflowId} 落点是 ${place.targetId} 且含 SQL 节点,必须传该 target 的 redshiftSecretArn ` +
        `(§3.9a:禁 IAM fallback,不许省略 SecretArn)`
    );
  }
}

/** 该工作流的节点里有没有 SQL 节点(两个生成器共用同一判据)。 */
export function hasSqlNode(nodes: Array<{ type?: string }> | undefined): boolean {
  return (nodes || []).some((n) => n?.type === "sql");
}
