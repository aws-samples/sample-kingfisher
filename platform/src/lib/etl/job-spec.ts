// 序 73 模块 57(57 DESIGN §3.2)—— 离线计算作业(Glue / Redshift)的 **serverless 运行 spec 唯一作者**。
//
// 【为什么要有这个文件】`ServerlessJobSpec` 的字段集合原来只在 `lib/etl/dag-fanout.ts#publishFanout` 的 serverless 分支里
//   以对象字面量的形式存在一份。模块 57 让编排 DAG 的「离线作业节点」跑**同一份 spec**(同一个按区 Glue 作业名 / 同一组 Redshift
//   语句 / 同一把作业锁 / 同一张台账),如果在 job-node-spec.ts 里再抄一遍,就是本仓最贵的那类缺陷(两份静默分叉)。
//   所以把字面量**原样搬到这里**(字段顺序逐字不变 —— 单作业载体的 YAML 要与已发布的产物逐字节相等,B-09 载体漂移判据读的就是它),
//   发布扇出与工作流节点都只能调本函数。
// 【边界】本文件**纯函数、零 AWS 调用**:端点所在区 / 数仓绑定 / 定时分组这些要解析的事实由调用方解析后以 `facts` 传入
//   (扇出在 `forEachTargetPlace` 的循环体里解析,工作流节点在发布期解析)。
import { homeRegion } from "@/lib/place/home-region";
import { TABLES } from "@/lib/aws/dynamodb";
import { splitSql as splitSqlForDag } from "@/lib/etl/dag-generator";
import { lockAttrFor } from "@/lib/etl/run-lock";
import { glueJobNameFor } from "@/lib/etl/glue-job-name";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { buildPlaceWire, type PlaceWire } from "@/lib/place/wire";
import type { ServerlessJobSpec } from "@/lib/scheduler/serverless/yaml-generator";
import type { EtlJob } from "@/types/etl-job";

/** 数仓绑定里 spec 用得到的那几样(`resolveRedshiftBinding` 的子集;glue 作业不带)。 */
export interface EtlSpecRedshiftBinding {
  region: string;
  workgroup: string;
  database: string;
  secretArn?: string | null;
}

/** 调用方解析好的事实(spec 的输入;本文件不去解析它们)。 */
export interface EtlJobSpecFacts {
  /** 这一份产物的 dag_id(单作业载体 = `dagIdForTarget(base, targetId)`;工作流节点 = 工作流自己的 dagId) */
  dagId: string;
  /** 调度端点所在区(glue 作业的执行区;redshift 作业以绑定的区为准) */
  endpointRegion: string;
  /** redshift 作业**必须**带本 target 的数仓绑定;glue 作业传 undefined */
  binding: EtlSpecRedshiftBinding | undefined;
  /** 定时确定性分组(只有单作业载体扇出到 >1 个 target 时才有;工作流节点不带) */
  scheduledGroup?: ServerlessJobSpec["scheduledGroup"];
}

/**
 * @kf-batch 50-WP31-place-first-class —— 序 4(L6):serverless 作业 spec 的执行落点(PlaceWire)。
 * 🔴 redshift 作业必须带**本 target 的**数仓绑定 —— 原来是 `binding?.workgroup ?? resolveWorkgroupForSpec(job)` /
 *    `?? "dev"` 两个缺省(绑定缺失时拿作业行上的 / 主控区的值顶上);绑定在 redshift 分支里恒有,缺省是死代码,
 *    留着就是「哪天绑定没解析出来,就静默用主控区的工作组」的那条路。区:有绑定取绑定的,否则(glue)取端点所在区
 *    —— 与原 `binding?.region ?? ep.region` 逐字同值。
 */
export function serverlessPlaceOf(
  targetId: string,
  endpointRegion: string,
  binding: EtlSpecRedshiftBinding | undefined
): PlaceWire {
  return buildPlaceWire({
    targetId,
    region: binding?.region ?? endpointRegion,
    ...(binding ? { redshift: { workgroup: binding.workgroup, database: binding.database, secretArn: binding.secretArn ?? null } } : {}),
  });
}

// @kf-batch 50-WP15-airflow-serverless —— serverless spec 用的小口径(与 lib/etl/dag-generator.ts 的 splitSql 同源导出)
function splitSqlForSpec(script: string): string[] {
  return splitSqlForDag(script);
}

/**
 * 离线计算作业在某个 target 上的 serverless 运行 spec(**唯一作者**)。
 * 🔴 字段顺序 / 取值与搬出前的 `dag-fanout.ts` 字面量逐字相同;redshift 作业 `facts.binding` 缺失即抛(不许静默回落主控区数仓)。
 */
export function serverlessJobSpecFor(job: EtlJob, targetId: string, facts: EtlJobSpecFacts): ServerlessJobSpec {
  if (job.type === "redshift" && !facts.binding) {
    throw new Error(`redshift 作业 ${job.jobId} 在 ${targetId} 上缺数仓绑定 ⇒ 拒绝生成 spec(不回落主控区数仓)`);
  }
  const ctrlRegion = homeRegion();
  const stamp = resolveRunStamp(job, targetId);
  const spec: ServerlessJobSpec = {
    engine: job.type === "glue" ? "glue" : "redshift",
    jobId: job.jobId,
    dagId: facts.dagId,
    taskType: `etl-${job.type}`,
    jobsTable: TABLES.ETL_JOBS,
    ctrlRegion,
    // @kf-batch 50-WP31-place-first-class —— 序 4(L6):执行落点 = PlaceWire(原 execRegion + 数仓三样合并;运行时同源读取、缺即拒)
    place: serverlessPlaceOf(targetId, facts.endpointRegion, job.type === "redshift" ? facts.binding : undefined),
    lockAttr: lockAttrFor({ targetId }),
    stamp: { projectId: stamp.projectId, targetId }, // 章的 targetId 就是本份产物的 target(不经 stamp 读,守卫只认绑定持有者)
    // @kf-batch 50-WP5-rungroup —— O2 定时确定性分组(是否注入由调用方按**全部绑定**判,见 dag-fanout.ts)
    ...(facts.scheduledGroup ? { scheduledGroup: facts.scheduledGroup } : {}),
    ...(job.type === "glue"
      ? { glueJobName: glueJobNameFor(job.jobId, targetId) }
      : {
          statements: splitSqlForSpec(job.script),
        }),
  };
  return spec;
}
