// @kf-batch 50-WP4quater-reads(工单 SC-2)
/**
 * **建源落点** —— 「这条数据源建在哪个区、用那个区的哪个子网 / VPC / 可用区 / Glue 角色」。
 *
 * 用户 2026-09-10:「**所有的任务都要创建在当前区域,不能只是创建在主控区,没意义,
 * 除非在主控区创建任务,可以选择在主控区下发到其他指定区域执行。不然也是白干了。**」
 *
 * 🔴 为什么建源是这条链的第一环:同步任务的落点由它引用的**数据源**的 `ownerTargetId` 派生
 * (`bindingForNewSyncTask`)。所以「数据源只能建在主控区」在语义上就等于「同步任务只能落主控区」——
 * 读侧过滤做得再干净也改变不了这一点。
 *
 * 🔴 网络事实取该区 core 袋的 `emrSubnetIds`(那就是那个区的私有子网,EMR 现在就用它们跑),
 * 再用**该区的** EC2 客户端把子网的 VPC 与可用区读出来。
 * **绝不回落主控区的 `DEFAULT_VPC_ID` / `DEFAULT_SUBNET_ID`**:那会把安全组建在主控区的 VPC 里,
 * Glue 连接引用一个跨区安全组 —— 创建时不报错,**跑作业时才炸**,而报错指向网络配置。
 */
import { homeRegion } from "@/lib/place/home-region";
import { HOME_TARGET_ID, isHome, isValidTargetId } from "@/lib/exec-env/target-id";
import { resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { requireReadyTarget } from "@/lib/exec-env/registry";
import { ec2ClientFor } from "@/lib/exec-env/target-clients";
// @kf-batch 50-WP31-place-first-class 序 31 二刀 ⑤:数据源的区解析就是落点决策 ⇒ 在唯一作者这里记账(观测器据此归因)
import { notePlaceDecision } from "@/lib/place/context";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";

/** 决策记账里的作者名(观测清单按它归类;判据按它过滤)。 */
export const DS_PLACE_VIA = "resolveDsPlace";
export const DS_ROW_PLACE_VIA = "datasourceRowPlace";

/**
 * 序 31 二刀 ⑤:**按数据源行**记落点决策 —— 浏览表 / 心跳 / 发现 / S3 外表 / 改删源等路径拿到的是 `bgp-datasources` 的一行,
 * 区从行上的章(`ownerTargetId`,唯一读法 `datasourceOwnerTarget`)或 secret ARN 派生,从不经 `resolveDsPlace`
 * ⇒ 测试账号 observe 未归因榜里 `secretsmanager.GetSecretValue /api/datasources/<id>/tables`、`glue.GetJobRun /api/datasources`、
 * `s3 … /s3-external` 全是这一类:客户端建对了区,账本上却一笔都没有。
 * 🔴 必须在该路径第一个 AWS 调用之前调(观测器在请求发出那一刻读账本);永不抛 —— 章非法由业务路径自己的 `targetOfStamp` 去抛。
 */
export function noteDatasourceRowPlace(ds: { ownerTargetId?: unknown } | null | undefined): void {
  try {
    notePlaceDecision({ targetId: datasourceOwnerTarget(ds as Record<string, unknown> | null | undefined), via: DS_ROW_PLACE_VIA });
  } catch {
    /* 章非法:不记;业务路径随后用同一个读法会抛出可读错误 */
  }
}

export interface DsPlaceResolved {
  targetId: string;
  region: string;
  home: boolean;
  /** Glue 作业执行角色(非 home = 该 target 自己的;home = 由 `ensureGlueRole()` 保障) */
  glueRoleArn?: string;
  vpcId?: string;
  subnetId?: string;
  availabilityZone?: string;
}

// @kf-batch 50-WP31-place-first-class —— 落点必填(原来缺省 = 主控区);存量行的章由调用方经 targetOfStamp 显式给
export async function resolveDsPlace(targetId: string): Promise<DsPlaceResolved> {
  const tid = targetId;
  if (!isValidTargetId(tid)) {
    throw new Error(`非法 targetId:${JSON.stringify(targetId)}`);
  }
  // 序 31 二刀 ⑤:建源 / 改源 / 删源 / 发现实例的区解析就是落点决策 ⇒ 在这里记(第一个 await 之前;请求外无账本则 no-op)。
  //   测试账号 observe 未归因榜:`ec2 / secretsmanager / glue / rds … /api/datasources` 全是「经本函数拿到了正确的区、客户端也建对了,
  //   却没有一笔决策」—— 主控区源在下面的早退分支里连 resolveGlueBinding 的那笔都没有。非法 id 抛在记账之前(它不是一个落点)。
  notePlaceDecision({ targetId: tid, via: DS_PLACE_VIA });
  if (isHome(tid)) {
    return { targetId: HOME_TARGET_ID, region: homeRegion(), home: true };
  }
  // 非 home:region 与 Glue 角色取描述符实名资源袋(缺一即拒,由 resolveGlueBinding 负责)
  const b = await resolveGlueBinding({ targetId: tid });
  const t = await requireReadyTarget(tid);
  const res = (t.resources ?? {}) as Record<string, unknown>;
  const subnets = Array.isArray(res.emrSubnetIds)
    ? res.emrSubnetIds.filter((x): x is string => typeof x === "string" && x.startsWith("subnet-"))
    : [];
  if (subnets.length === 0) {
    throw new Error(
      `不能在 ${tid}(${b.region})建数据源:那个执行环境的描述符里没有私有子网(core 袋的 emrSubnetIds)。` +
        `🔴 平台刻意不回落主控区的子网 —— 那会把安全组建在主控区,Glue 连接引用一个跨区安全组,` +
        `创建时不报错、跑作业时才炸`
    );
  }
  // 用**该区**的 EC2 客户端把 VPC 与可用区读出来(不猜:子网 id 里看不出这两样)
  const ec2 = await ec2ClientFor(b.region);
  const { DescribeSubnetsCommand } = await import("@aws-sdk/client-ec2");
  const out = (await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnets[0]] }))) as {
    Subnets?: Array<{ VpcId?: string; AvailabilityZone?: string }>;
  };
  const sn = out.Subnets?.[0];
  if (!sn?.VpcId || !sn.AvailabilityZone) {
    throw new Error(`读不到子网 ${subnets[0]} 在 ${b.region} 的 VPC / 可用区 —— 拒绝建源(不猜网络)`);
  }
  return {
    targetId: tid,
    region: b.region,
    home: false,
    glueRoleArn: b.roleArn,
    vpcId: sn.VpcId,
    subnetId: subnets[0],
    availabilityZone: sn.AvailabilityZone,
  };
}
