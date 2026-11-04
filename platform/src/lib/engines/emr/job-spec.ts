// EMR Serverless 引擎作业的 **serverless 运行 spec 唯一作者**。
//
// 【为什么要有这个文件】`ServerlessJobSpec`(emr 分支)的字段集合原来只在 `schedule-fanout.ts#publishEmrFanout` 的 serverless 分支里
//   以对象字面量存在一份;让编排 DAG 的「离线作业节点」跑**同一份 spec**(同一个 application + 执行角色 + spark 参数 +
//   日志落点)。各抄一份 = 静默分叉 ⇒ 字面量**原样搬到这里**(字段顺序逐字不变,单作业载体 YAML 与已发布产物逐字节相等),
//   `sparkSubmitParameters` 的拼法也收成一个作者(`emrSparkSubmitParametersFor`,与 provider.submit 逐项同口径)。
// 【边界】本文件**纯函数、零 AWS 调用**;脚本上传 / jar 复制 / application 建立这些写操作留在调用方
//   (扇出:schedule-fanout.ts 循环体;工作流节点:发布写阶段 job-node-prepare.ts)。只读解析时用 `entryPointUri` / `s3TablesJarUriFor`
//   / `applicationIdOf` 这些**确定性**读法得到同一个值。
import { homeRegion } from "@/lib/place/home-region";
import { TABLES } from "@/lib/aws/dynamodb";
import { resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import type { TargetSparkLanding } from "@/lib/exec-env/target-clients";
import { lockAttrFor } from "@/lib/etl/run-lock";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { buildPlaceWire } from "@/lib/place/wire";
import type { ServerlessJobSpec } from "@/lib/scheduler/serverless/yaml-generator";
import { S3TABLES_WAREHOUSE_ARN } from "./provider";
import { s3TablesCatalogParameters, toSparkSubmitParameters, userSparkConfToParameters, bgpLandingParameters } from "./spec";
import type { EmrEngineJob } from "./types";

/** 该区数仓连接事实(注进 `spark.bgp.redshift*`;不是所有 EMR 作业都碰数仓 ⇒ 解析失败不阻断、但绝不静默当「不需要」)。 */
export type EmrRedshiftFacts = { redshiftWorkgroup?: string; redshiftDatabase?: string; redshiftSecretArn?: string };

/**
 * 解析该 target 的 Redshift 连接事实。🔴 失败**不阻断作业**(与 provider.submit / schedule-fanout 同一口径):
 * 拿不到就回空对象,生成的代码会因为 conf 取不到而当场报错,而不是连上一个没授权的临时用户再报 permission denied。
 */
export async function emrRedshiftFactsFor(targetId: string): Promise<EmrRedshiftFacts> {
  try {
    const rb = await resolveRedshiftBinding({ targetId });
    return { redshiftWorkgroup: rb.workgroup, redshiftDatabase: rb.database, redshiftSecretArn: rb.secretArn };
  } catch {
    return {}; // 不阻断;见 provider.ts 同处的整段理由
  }
}

/** 该区表桶的 catalog warehouse ARN(拿 home 的 ARN 去那个区 = 跨区写元数据)。 */
export function emrS3TablesWarehouseArnFor(landing: Pick<TargetSparkLanding, "home" | "region" | "tableBucket">): string {
  return landing.home ? S3TABLES_WAREHOUSE_ARN : `arn:aws:s3tables:${landing.region}:${process.env.AWS_ACCOUNT_ID}:bucket/${landing.tableBucket}`;
}

/**
 * sparkSubmitParameters(**唯一作者**):平台规格(保留键)+ 平台注入 S3 Tables catalog + 该区落点事实 + 用户自定义 conf。
 * 🔴 与 provider.submit 的 `[specParams, s3tParams, bgpParams, userParams].filter(Boolean).join(" ")` 逐项同序同值
 *    (漏改一处 = 定时 / 工作流那条路依然 NoRegionError / permission denied)。
 */
export function emrSparkSubmitParametersFor(
  job: Pick<EmrEngineJob, "spec" | "sparkConf">,
  landing: TargetSparkLanding,
  s3tJar: string,
  rsFacts: EmrRedshiftFacts
): string {
  const s3tParams = s3TablesCatalogParameters(s3tJar, emrS3TablesWarehouseArnFor(landing));
  const bgpParams = bgpLandingParameters({ ...landing, ...rsFacts });
  return [toSparkSubmitParameters(job.spec), s3tParams, bgpParams, userSparkConfToParameters(job.sparkConf)].filter(Boolean).join(" ");
}

/** 调用方解析好的事实(spec 的输入;本文件不去解析它们)。 */
export interface EmrJobSpecFacts {
  /** 这一份产物的 dag_id(单作业载体 = `dagIdForTarget(base, targetId)`;工作流节点 = 工作流自己的 dagId) */
  dagId: string;
  /** 该 target 的执行区(= `resolveEmrBinding` 的 landing.region) */
  region: string;
  applicationId: string;
  executionRoleArn: string;
  entryPoint: string;
  sparkSubmitParameters: string;
  logUri: string;
  runName: string;
  /** 定时确定性分组(只有单作业载体扇出到 >1 个 target 时才有;工作流节点不带) */
  scheduledGroup?: ServerlessJobSpec["scheduledGroup"];
}

/**
 * EMR 引擎作业在某个 target 上的 serverless 运行 spec(**唯一作者**)。
 * 🔴 字段顺序 / 取值与搬出前的 `schedule-fanout.ts` 字面量逐字相同。
 */
export function emrJobSpecFor(job: EmrEngineJob, targetId: string, facts: EmrJobSpecFacts): ServerlessJobSpec {
  const ctrlRegion = homeRegion();
  const stamp = resolveRunStamp(job, targetId);
  const spec: ServerlessJobSpec = {
    engine: "emr",
    jobId: job.jobId,
    dagId: facts.dagId,
    taskType: "emr-serverless",
    jobsTable: TABLES.ENGINE_JOBS,
    ctrlRegion,
    // 执行落点 = PlaceWire(原 execRegion;运行时同源读取、缺即拒)
    place: buildPlaceWire({ targetId, region: facts.region }),
    lockAttr: lockAttrFor({ targetId }),
    stamp: { projectId: stamp.projectId, targetId }, // 章的 targetId 就是本份产物的 target(不经 stamp 读,守卫只认绑定持有者)
    // O2 定时确定性分组(是否注入由调用方按**全部绑定**判,见 schedule-fanout.ts)
    ...(facts.scheduledGroup ? { scheduledGroup: facts.scheduledGroup } : {}),
    applicationId: facts.applicationId,
    executionRoleArn: facts.executionRoleArn,
    entryPoint: facts.entryPoint,
    entryPointArguments: job.entryPointArguments || [],
    sparkSubmitParameters: facts.sparkSubmitParameters,
    logUri: facts.logUri,
    runName: facts.runName,
  };
  return spec;
}
