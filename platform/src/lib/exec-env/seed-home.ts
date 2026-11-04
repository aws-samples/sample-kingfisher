// @kf-batch 50-P50.2e2-seed-home
// home 描述符的**部署期 seed 真调用方**(SPEC §1.1;G 批 P1-1 定案里一直欠着的那半边)。
//
// 【为什么现在才有】G 批刻意规定"在真实 seed 调用方落地前 home 不被 seed、`getHomeTarget()`
// 恒 fail-closed"(防读路径自愈写库的 P1-1)。切片 e 落了**非 home** 的回写(CFN Outputs),
// home 的存量资源没有那些 Outputs ⇒ 走 §1.1 的另一分支:**实时查询组装**。
// 用户实测撞上空列表(2026-09-01:「执行环境为什么没有显示当前执行环境?」)⇒ 本文件补上。
//
// 【组装口径 —— 逐项写明"为什么不是从 env 猜"】
//   · 固定名资源(桶/表桶/Athena WG/workgroup/namespace/库/MWAA/DMS 子网组/角色名):
//     取自**命名 SSOT 的 home 豁免**(platform/naming.json —— 那些值有门禁钉着与 infra 现网逐字一致);
//   · emrSecurityGroupId:EC2 按名查真 id(与现网执行路径 platform-env.ts#defaultSgId 同一查询);
//   · emrSubnetIds:`EMR_DEFAULT_SUBNET_IDS`(CDK 部署期注入的实名,现网 EMR 作业就用它跑 ——
//     这不是"从 env 猜",是部署期真值;为空则 fail-closed 报错,绝不臆造);
//   · redshiftSecretArn:DescribeSecret 托管名 `redshift!bgp-namespace-admin` → 真 ARN
//     (与 glue-script-generator / admin-secret 同一权威名);
//   · 组件集:core + redshift + mwaa 恒真(app.ts 无条件实例化);dms / flink **逐个探测**
//     (门控栈,不在就不声称 —— 声称了装而没装,§3.1a 的组件↔资源配套会拒,拒得对)。
//
// 🔴 写库走**既有** `seedHomeTarget`(整包校验 ∧ ready=true ∧ status 可用;已存在则位置比对):
//    本文件只负责"组装真值",一行校验都不自己发明。
import { homeRegion } from "@/lib/place/home-region";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { EC2Client, DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { SecretsManagerClient, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";
import { DatabaseMigrationServiceClient, DescribeReplicationSubnetGroupsCommand } from "@aws-sdk/client-database-migration-service";
import { IAMClient, GetRoleCommand } from "@aws-sdk/client-iam";
// @kf-batch 50-WP20-retire-classic-mwaa —— 探「经典 MWAA 环境到底在不在」
import { MWAAClient, GetEnvironmentCommand } from "@aws-sdk/client-mwaa";
import {
  BedrockAgentCoreControlClient, GetAgentRuntimeCommand, GetMemoryCommand, ListGatewaysCommand, GetGatewayCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { resourceName } from "@/lib/aws/naming";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { getControlPlaneContext } from "@/lib/exec-env/aws-context";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
// @kf-batch 50-WP31-seq5-dataplane-role —— 散建收口到唯一工厂(序 5:数据面凭证注入点只有这一处)
import { sdkClient } from "@/lib/aws/clients";

const HOME_REGION = homeRegion();
const ec2 = sdkClient("control-plane", EC2Client, { region: HOME_REGION });
const sm = sdkClient("control-plane", SecretsManagerClient, { region: HOME_REGION });
const dms = sdkClient("control-plane", DatabaseMigrationServiceClient, { region: HOME_REGION });
const iam = sdkClient("control-plane", IAMClient, { region: HOME_REGION });
const mwaa = sdkClient("control-plane", MWAAClient, {});
const s3 = sdkClient("control-plane", S3Client, {});
const agentcoreControl = sdkClient("control-plane", BedrockAgentCoreControlClient, { region: HOME_REGION });

/**
 * genbi 的 AgentCore gateway 名。命名登记在 naming.json `notCovered.agentcore`
 * (模式 `bgp-<capabilityId>-gateway`,由 infra/lib/shared/agentcore-base.ts 派生;capabilityId=genbi)。
 */
const GENBI_GATEWAY_NAME = "bgp-genbi-gateway";

/** home 的 Redshift 托管 admin secret 名(命名 SSOT 的 redshiftAdminSecretName home 值)。 */
const HOME_ADMIN_SECRET_NAME = resourceName("redshiftAdminSecretName", { targetId: HOME_TARGET_ID });

export interface HomeFacts {
  accountId: string;
  region: string;
  partition: string;
  emrSecurityGroupId: string;
  emrSubnetIds: string[];
  redshiftSecretArn: string;
  /** 门控组件的探测结果(查到才声称)。 */
  dmsPresent: boolean;
  /**
   * @kf-batch 50-WP20-retire-classic-mwaa
   * 🔴 经典 MWAA 是否**真的存在**(用户 2026-09-14:「把 MWAA 的部署版本去掉,都走 MWAA Serverless」)。
   *
   * 改动前这里是**写死的** `"mwaa"` —— 而 home 不再部署经典 MWAA 之后,写死就等于**描述符撒谎**:
   * 调度选路会挑经典 MWAA、拿着一个不存在的环境名去 `CreateCliToken` ⇒ 定时功能整体坏掉,
   * 而症状离「少部署了一个栈」很远。⇒ 与 dms / flink / agentcore 一样:**探到才声称**。
   */
  mwaaPresent: boolean;
  flinkPresent: boolean;
  flinkRoleArn?: string;
  /**
   * agentcore 门控(P50.2e3,用户实测反馈驱动:「home 缺 agentcore」):
   * runtime READY ∧ memory ACTIVE ∧ gateway READY(带真 URL)三者齐 ⇒ 才声称;
   * 三字段是 §1.1 agentcore 袋的必填集,缺一声称就会被 §3.1a 配套校验拒 —— 拒得对。
   */
  agentcore?: { genbiRuntimeArn: string; genbiMemoryId: string; gatewayUrl: string };
  /** @kf-batch 50-WP15-airflow-serverless:home 的 MWAA Serverless 入口(桶 / 角色 / SG 三样按 SSOT 名探到才声称) */
  airflowServerless?: { workflowBucket: string; roleArn: string; sgId: string };
}

/**
 * 采集 home 的运行时真值。core 三项(SG/子网/secret)**任一缺失即抛**(fail-closed:
 * 缺一角就写库 = 半份描述符,§20.11-N2 的教训);门控组件查不到只是"不声称",不是错误。
 */
// @kf-batch 50-WP15-airflow-serverless
// 🔴 可选组件探测的错误分类:只有「资源不存在」才等于「未部署 ⇒ 不声称」;权限 / 网络 / 限流等其它错误**必须抛出**。
//    真环境撞过:TaskRole 缺 iam:GetRole(bgp-airflow-sls-role)⇒ AccessDenied 被 catch 吞成「没装」,seed-home 回 200 却不声称组件,
//    页面上没有任何线索。把权限错当「未部署」= 静默 fail-open 到错误结论,与「查不到就撒谎」同罪。
export function isNotFoundError(e: unknown): boolean {
  const name = String((e as { name?: string })?.name ?? "");
  const code = Number((e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0);
  return /NoSuchEntity|NotFound|NoSuchBucket|ResourceNotFound/i.test(name) || code === 404;
}
function optionalProbeError(component: string, e: unknown): Error {
  const name = String((e as { name?: string })?.name ?? "Error");
  return new Error(
    `home 可选组件 ${component} 探测出错(${name}:${String((e as Error)?.message ?? e)})—— 这不是「未部署」:未部署会是 NotFound 类错误;` +
      `常见根因 = 平台 TaskRole 缺对应只读权限(iam:GetRole / s3:ListBucket / ec2:DescribeSecurityGroups)。不声称 = 撒谎,故拒绝落库`
  );
}

export async function fetchHomeFacts(): Promise<HomeFacts> {
  const ctx = await getControlPlaneContext();

  // EMR 默认 SG(按名查真 id;与 platform-env.ts 同一查询与同一名字来源)
  const sgName = resourceName("emrSecurityGroup", { targetId: HOME_TARGET_ID });
  const sgOut = await ec2.send(
    new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [sgName] }] })
  );
  const emrSecurityGroupId = sgOut.SecurityGroups?.[0]?.GroupId ?? "";
  if (!emrSecurityGroupId) {
    throw new Error(`home 缺 EMR 默认安全组 ${sgName}(EMR 栈未部署?)—— core 必填,不写半份描述符`);
  }

  const emrSubnetIds = (process.env.EMR_DEFAULT_SUBNET_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (emrSubnetIds.length === 0) {
    throw new Error("EMR_DEFAULT_SUBNET_IDS 为空 —— 该值由 CDK 部署期注入(现网 EMR 作业同源),为空说明平台栈部署异常");
  }

  const sec = await sm.send(new DescribeSecretCommand({ SecretId: HOME_ADMIN_SECRET_NAME }));
  const redshiftSecretArn = sec.ARN ?? "";
  if (!redshiftSecretArn) throw new Error(`查不到 Redshift 托管 admin secret(${HOME_ADMIN_SECRET_NAME})`);

  // 门控组件探测:查到才声称(声称了没装,§3.1a 组件↔资源配套会拒;不查就写 = 撒谎)
  let dmsPresent = false;
  try {
    const g = await dms.send(
      new DescribeReplicationSubnetGroupsCommand({
        Filters: [{ Name: "replication-subnet-group-id", Values: [resourceName("dmsSubnetGroup", { targetId: HOME_TARGET_ID })] }],
      })
    );
    dmsPresent = (g.ReplicationSubnetGroups?.length ?? 0) > 0;
  } catch (e) {
    if (!isNotFoundError(e)) throw optionalProbeError("dms", e);
    dmsPresent = false; // 资源不存在 ⇒ 不声称(权限等其它错误已抛出)
  }
  let flinkPresent = false;
  let flinkRoleArn: string | undefined;
  try {
    const r = await iam.send(new GetRoleCommand({ RoleName: resourceName("flinkRole", { targetId: HOME_TARGET_ID }) }));
    flinkRoleArn = r.Role?.Arn;
    flinkPresent = Boolean(flinkRoleArn);
  } catch (e) {
    if (!isNotFoundError(e)) throw optionalProbeError("flink", e);
    flinkPresent = false;
  }
  // @kf-batch 50-WP20-retire-classic-mwaa
  // 🔴 经典 MWAA:**探到才声称**。用户 2026-09-14 拍板不再部署它(常驻 ≈$350/月,而 serverless 按任务秒计费、
  //    部署分钟级、用法基本一样)。存量环境里它可能还在 ⇒ 这里不是「一律不声称」,而是「按事实」。
  let mwaaPresent = false;
  try {
    const env = await mwaa.send(new GetEnvironmentCommand({ Name: resourceName("mwaaEnvName", { targetId: HOME_TARGET_ID }) }));
    mwaaPresent = Boolean(env.Environment?.Arn);
  } catch (e) {
    if (!isNotFoundError(e)) throw optionalProbeError("mwaa", e);
    mwaaPresent = false;
  }

  // @kf-batch 50-WP15-airflow-serverless:三样按 SSOT 名探(桶 HeadBucket / 角色 GetRole / SG 按名查 id);任一缺 ⇒ 不声称
  let airflowServerless: HomeFacts["airflowServerless"];
  try {
    const wb = resourceName("workflowBucket", { targetId: HOME_TARGET_ID, account: ctx.accountId });
    await s3.send(new HeadBucketCommand({ Bucket: wb }));
    const r = await iam.send(new GetRoleCommand({ RoleName: resourceName("airflowServerlessRole", { targetId: HOME_TARGET_ID }) }));
    const sgq = await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [resourceName("airflowServerlessSg", { targetId: HOME_TARGET_ID })] }] }));
    const sgId = sgq.SecurityGroups?.[0]?.GroupId;
    if (r.Role?.Arn && sgId) airflowServerless = { workflowBucket: wb, roleArn: r.Role.Arn, sgId };
  } catch (e) {
    if (!isNotFoundError(e)) throw optionalProbeError("airflow-serverless", e);
    airflowServerless = undefined; // 未部署 BgpAirflowServerlessStack(桶 / 角色 NotFound)⇒ 不声称
  }

  // agentcore 门控(与 dms/flink 同哲学:查到全部真值才声称,查询失败/缺任一 = 不声称,不是错误)。
  //   · genbiRuntimeArn / genbiMemoryId:CDK 部署期注入的实名 env(与现网 genbi 功能同源,非"从 env 猜");
  //   · gatewayUrl:控制面 GetGateway 动态取真 URL(ListGateways 的该字段为 null,单查才有 —— 实测);
  //   · 三资源状态逐个核(runtime READY / memory ACTIVE / gateway READY,字面值 2026-09-01 真环境核过):
  //     任何一个不健康就不声称 —— 声称了,seed 前置的整轮真探会红、409 拒落库,home 连 core 都上不了。
  let agentcore: HomeFacts["agentcore"];
  try {
    const genbiRuntimeArn = process.env.GENBI_RUNTIME_ARN || "";
    const genbiMemoryId = process.env.GENBI_MEMORY_ID || "";
    if (genbiRuntimeArn && genbiMemoryId) {
      const rt = await agentcoreControl.send(
        new GetAgentRuntimeCommand({ agentRuntimeId: genbiRuntimeArn.split("/").pop() ?? "" })
      );
      const mem = await agentcoreControl.send(new GetMemoryCommand({ memoryId: genbiMemoryId }));
      if (rt.status === "READY" && mem.memory?.status === "ACTIVE") {
        const gl = await agentcoreControl.send(new ListGatewaysCommand({}));
        const gw = (gl.items ?? []).find((g) => g.name === GENBI_GATEWAY_NAME);
        if (gw?.gatewayId) {
          const gd = await agentcoreControl.send(new GetGatewayCommand({ gatewayIdentifier: gw.gatewayId }));
          if (gd.status === "READY" && gd.gatewayUrl) {
            agentcore = { genbiRuntimeArn, genbiMemoryId, gatewayUrl: gd.gatewayUrl };
          }
        }
      }
    }
  } catch (e) {
    if (!isNotFoundError(e)) throw optionalProbeError("agentcore", e);
    agentcore = undefined; // 资源不存在 ⇒ 不声称(权限等其它错误已抛出)
  }

  return { ...ctx, emrSecurityGroupId, emrSubnetIds, redshiftSecretArn, dmsPresent, flinkPresent, flinkRoleArn, mwaaPresent, agentcore, airflowServerless };
}

/**
 * 由真值组装 home 描述符候选(纯函数,单测的主战场)。
 * 名字全部出自命名 SSOT 的 home 豁免;组件集只含"查到的"。
 */
export function buildHomeDescriptor(
  facts: HomeFacts,
  actor: string,
  now: string
): Omit<ExecutionTarget, "pk" | "sk" | "targetId" | "isHome"> & { isHome: true } {
  const home = (kind: string) => resourceName(kind, { targetId: HOME_TARGET_ID, account: facts.accountId });
  const components = [
    "core",
    "redshift",
    // @kf-batch 50-WP20-retire-classic-mwaa —— 探到才声称(原来写死;见 HomeFacts.mwaaPresent 的理由)
    ...(facts.mwaaPresent ? ["mwaa"] : []),
    ...(facts.dmsPresent ? ["dms"] : []),
    ...(facts.flinkPresent ? ["flink"] : []),
    ...(facts.agentcore ? ["agentcore"] : []),
    // @kf-batch 50-WP15-airflow-serverless
    ...(facts.airflowServerless ? ["airflow-serverless"] : []),
  ];
  const resources: Record<string, unknown> = {
    datalakeBucket: home("datalakeBucket"),
    scriptsBucket: home("scriptsBucket"),
    tableBucket: home("tableBucket"),
    athenaWorkgroup: home("athenaWorkgroup"),
    glueRoleArn: `arn:${facts.partition}:iam::${facts.accountId}:role/${home("glueRole")}`,
    emrSecurityGroupId: facts.emrSecurityGroupId,
    emrSubnetIds: facts.emrSubnetIds,
    redshiftWorkgroup: home("redshiftWorkgroup"),
    redshiftDatabase: home("redshiftDatabase"),
    redshiftSecretArn: facts.redshiftSecretArn,
    // dagBucket 由**平台栈**建(经典 MWAA 与 serverless 都不拥有它)⇒ 恒声称
    dagBucket: home("dagBucket"),
    // @kf-batch 50-WP20-retire-classic-mwaa —— 环境名只在**真有那个环境**时才写(配套规则 mwaa → [dagBucket, mwaaEnvName])
    ...(facts.mwaaPresent ? { mwaaEnvName: home("mwaaEnvName") } : {}),
  };
  if (facts.dmsPresent) resources.dmsSubnetGroup = home("dmsSubnetGroup");
  if (facts.flinkPresent && facts.flinkRoleArn) resources.flinkRoleArn = facts.flinkRoleArn;
  if (facts.airflowServerless) {
    resources.workflowBucket = facts.airflowServerless.workflowBucket;
    resources.airflowServerlessRoleArn = facts.airflowServerless.roleArn;
    resources.airflowServerlessSgId = facts.airflowServerless.sgId;
  }

  return {
    partition: facts.partition as ExecutionTarget["partition"],
    accountId: facts.accountId,
    region: facts.region,
    jurisdiction: "home",
    displayName: "Home(控制面所在区)",
    isHome: true,
    // §1.1:agentcore 袋是顶层 M 字段(不在 resources);声称组件才带(§3.1a 配套)。
    ...(facts.agentcore ? { agentcore: { ...facts.agentcore } } : {}),
    // seed 的「完整」判据(SPEC §1.1 v3.6):整包校验 ∧ ready=true ∧ status 可承接工作。
    status: "active",
    ready: true,
    components,
    resources,
    credentialIsolationState: "legacy-seeded",
    credentialEpoch: 0,
    version: 1,
    createdBy: actor,
    updatedAt: now,
  };
}
