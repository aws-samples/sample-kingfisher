// @kf-batch 50-WP16-zero-egress
// 执行环境 **VPC 端点清单的唯一作者**(50 SPEC v3.33 §3.16-B)。
//
// 【为什么必须是单一作者】
//   零出网的形状是「凡任务要调的 AWS 服务,都得有对应端点」。这个清单一旦有第二份,
//   漏一项的症状是**该服务的调用在私有子网里静默超时 10 秒然后失败** —— 离根因极远,
//   而且只有真环境两个区才现形(单测里 SDK 被 mock,永远绿)。
//   ⇒ 清单只此一处;synth 门禁与 `net0` 判据都读**这里**,并且额外做一层
//   「清单 ⊇ 运行时代码里 grep 出的 boto3 服务集」的比对(ACCEPTANCE N0-2 第二层)。
//
// 🔴 **清单怎么定的**:不按 IAM 策略反推(那样得到的是权限面,不是网络面),
//   而是按**运行时真实 `boto3.client/resource` 调用**定 —— 2026-09-08 spike 就是这么定的,
//   并且当场发现原设计清单漏了 `s3tables` 与 `redshift-serverless` 两个
//   (前者数据湖落地必经;后者被 `lib/sync/glue-script-generator.ts` 的 COPY 角色发现逻辑真调)。
//   台账见 WORK-PACKAGES WP-16 ②b 的 S-7。

import type { ExecEnvComponent } from "./context";

/**
 * 同区接口端点 —— **恒建**。
 * 每一项都在 2026-09-08 的零出网 spike 里真调成功过(耗时见 ②b S-7)。
 */
export const RUNTIME_INTERFACE_ENDPOINTS = [
  "sts",
  "logs",
  "monitoring",
  "kms",
  "secretsmanager",
  "glue",
  "emr-serverless",
  "redshift-data",
  "s3tables",
  "redshift-serverless",
] as const;

/** 经典 MWAA 官方要求的额外端点(仅装了 `mwaa` 组件时建)。 */
export const MWAA_CLASSIC_INTERFACE_ENDPOINTS = [
  "sqs",
  "ecr.api",
  "ecr.dkr",
  "airflow.api",
  "airflow.env",
  "airflow.ops",
] as const;

/** MWAA Serverless(仅装了 `airflow-serverless` 组件时建)。服务名 spike 已确认。 */
export const AIRFLOW_SERVERLESS_INTERFACE_ENDPOINTS = ["airflow-serverless"] as const;

/**
 * 网关端点(**免费**,挂私有路由表)。
 * 🔴 网关端点**不改 DNS**(靠路由表里的前缀列表 `pl-…`)⇒ 探活不能断「解析到私网」(②b S-10)。
 */
export const GATEWAY_ENDPOINTS = ["s3", "dynamodb"] as const;

/**
 * 🔴 要**经跨区私网通路回主控区**的服务:目前只有 **home 的 DynamoDB**(运行台账回写)。
 *
 * 【语义在 WP-23 变了,名字也跟着换】WP-16 时这里叫 `CROSS_REGION_ENDPOINTS`,意思是
 * 「在本区建哪些**跨区** VPC 端点」;而跨区端点被组织 SCP 拦死(`vpce:AllowMultiRegion`)⇒
 * 承载方式换成 **跨区 peering + 主控区那一侧的同区接口端点 + 本区私有托管域**(SPEC §3.14ter)。
 * 现在这个清单的意思是「**哪些服务名要被本区的私有托管域劫到主控区端点上**」。
 * 🔴 名字必须跟着语义改:留着 `CROSS_REGION_ENDPOINTS` 会让下一个人以为还在建跨区端点。
 *
 * 为什么只有它:唯一的跨区调用就是把 run 台账写回控制面的 `bgp-*` 表(SPEC §3.14「控制面回写 = 唯一跨区例外」)。
 * 🔴 为什么**没有** KMS:靶表虽是 CMK 加密,但 SSE-KMS 由 DynamoDB 服务侧代调 KMS,
 *    调用方无需网络可达 —— spike 未建任何跨区 KMS 端点而条件写照样成功(②b S-6)。
 */
export const HOME_LINK_SERVICES = ["dynamodb"] as const;

export interface EndpointPlan {
  /** 网关端点服务短名(挂私有路由表)。 */
  gateway: string[];
  /** 同区接口端点服务短名(privateDns 开)。 */
  iface: string[];
  /**
   * 要经**跨区私网通路**(peering + 主控区同区端点 + 本区私有托管域)回主控区的服务。
   * 空数组 = 本 target 与控制面同区(此时台账走**本区**网关端点,
   * 🔴 绝不能建同名私有托管域,否则会把自己这一区的 DynamoDB 解析也劫走)。
   */
  homeLink: { service: string; region: string }[];
}

/**
 * 按 target 的组件集算出端点计划。**纯函数**(synth 门禁与验收脚本都直接调它)。
 *
 * @param components 该 target 的组件全集(必含 `core`)
 * @param region     该 target 所在 region
 * @param homeRegion 控制面所在 region;非 home target 必须给(见 `context.ts` 的校验)
 */
export function endpointPlanFor(args: {
  components: readonly ExecEnvComponent[];
  region: string;
  homeRegion?: string;
}): EndpointPlan {
  const { components, region, homeRegion } = args;

  const iface = [...RUNTIME_INTERFACE_ENDPOINTS] as string[];
  if (components.includes("mwaa")) iface.push(...MWAA_CLASSIC_INTERFACE_ENDPOINTS);
  if (components.includes("airflow-serverless")) iface.push(...AIRFLOW_SERVERLESS_INTERFACE_ENDPOINTS);

  // 🔴 只有「与控制面不同区」才建 peering + 私有托管域。
  //    同区(比如 home 区里的第二个 target)走本区网关端点即可;若也建 PHZ,
  //    `dynamodb.<本区>.amazonaws.com` 会被劫到主控区端点上,把原本免费且正常的网关端点路径打断。
  const homeLink =
    homeRegion && homeRegion !== region
      ? HOME_LINK_SERVICES.map((service) => ({ service, region: homeRegion }))
      : [];

  return { gateway: [...GATEWAY_ENDPOINTS], iface: dedupeSorted(iface), homeLink };
}

function dedupeSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** 完整服务名(端点服务名的唯一构造点;跨区用对端 region 的名字)。 */
export function endpointServiceName(service: string, region: string): string {
  return `com.amazonaws.${region}.${service}`;
}

/**
 * 运行时真实调用的服务集(**判据用**,不是建端点用)。
 * 来源 = `grep -o "boto3.client|resource(\"<svc>\"" ` 运行时与三个 DAG 生成器。
 * ACCEPTANCE N0-2 第二层比对:`endpointPlanFor(...)` 的 iface ∪ gateway ⊇ 本集合。
 * 🔴 新增一个 boto3 调用而没进端点清单 ⇒ 门禁红(防「漏项」这类 bug 复发)。
 */
export const RUNTIME_BOTO3_SERVICES = [
  "dynamodb",
  "emr-serverless",
  "glue",
  "redshift-data",
  "redshift-serverless",
  "s3",
  "s3tables",
  "secretsmanager",
  "sts",
] as const;
