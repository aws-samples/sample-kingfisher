// 模块 33-A（根治·裂缝A）— EMR 平台环境事实的【单一事实源 + 运行时兜底】。
//
// 【为什么存在】平台把 EMR 可用的私有子网早已算好、由 CDK 注入成环境变量 EMR_DEFAULT_SUBNET_IDS
// (infra platform-stack.ts:853 = VPC 的 PRIVATE_WITH_EGRESS 子网,带 NAT 出网),但此前 platform/src
// 【无任何代码读它】——于是"网络"这项【平台环境客观事实】没有像 Redshift workgroup 那样的兜底:
//   · Redshift:job-service.ts:317  workgroup = job.redshiftConfig?.workgroupName || process.env.REDSHIFT_WORKGROUP || "bgp-workgroup"(三级兜底,config 空照跑)
//   · EMR 网络:application.ts:45   空就是空、零兜底 → 不带 networkConfiguration → 无 VPC → 连 s3tables API 超时
// 计划中心(planner)建 EMR 草稿时无"查网络"工具→ network 恒空,正是撞在这条"唯独没兜底"的裂缝上。
//
// 【本模块 = 补上这条兜底范式】把"已注入没人读"的事实真正接上,照 lib/realtime/flink-config.ts:23
// 的 env-SSOT 范式解析子网;SG 名(bgp-emr-sg)当前未经 env 注入,故按名 DescribeSecurityGroups 查
// (照 lib/realtime/dms-service.ts:53 已验证范式),带进程内缓存(SG id 生命周期内不变)。
//
// 🔴 边界:本模块含 AWS SDK(EC2 client),【纯服务端】,【绝不可被前端组件 import】。
//    EmrJobPanel.tsx:28 import 的是 lib/engines/emr/network.ts(纯类型/常量,无 SDK)——那条客户端边界
//    必须守住,故 SSOT 逻辑放这个独立文件,不进 network.ts。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { EC2Client, DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import type { EmrNetwork } from "./emr/network";
// G6(模块 50):SG id 缓存改按 targetId 键 —— 见 defaultSgId 上方注释。
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { locationCacheKey, ProcessCache } from "@/lib/exec-env/cred-cache";

const region = homeRegion();
const ec2 = sdkClient("data-plane", EC2Client, { region });

// EMR 默认安全组名(与 infra emr-stack.ts:32 securityGroupName 一致;allowAllOutbound=true,
// 且挂了 s3tables:* 权限——"私有子网 + 全出站 SG"这套组合经 30-seed 真跑连通 s3tables 坐实)。
const EMR_DEFAULT_SG_NAME = process.env.EMR_DEFAULT_SG_NAME || "bgp-emr-sg";

// 默认子网:CDK 注入的 EMR_DEFAULT_SUBNET_IDS(PRIVATE_WITH_EGRESS,逗号分隔)。照 flink-config.ts:23 解析。
function defaultSubnetIds(): string[] {
  return (process.env.EMR_DEFAULT_SUBNET_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// 默认 SG id 进程内缓存(SG id 在其生命周期内不变;查失败不缓存,下次重试)。
//
// ── 🔴 G6(模块 50)改造:单值 → 按 targetId 键 ─────────────────────────────────
// 原状是进程级单值:多 target 时**第一个 target 查出的 SG id 被所有 target 复用**,
// 而 SG 属于具体 VPC/region ⇒ 跨区拿到一个本区不存在的 SG id,EMR 提交会以一个
// 离根因很远的报错失败(甚至更糟:恰好撞上同名 SG,静默连错网络)。
//
// 🔴 键**只含 targetId**,刻意**没有 project / purpose 维**:SG 是纯位置轴(属于 VPC/region,
// 与项目、与凭证用途都无关)。给它加上那两维不是"更安全",而是把命中率打碎、
// 并暗示一个不存在的隔离语义。SSOT 见 lib/exec-env/cred-cache.ts 的 `locationCacheKey`。
//
// 语义保持不变:查到才缓存、查不到/出错返回 ""(不抛,由调用方决定)——
// `getEmrDefaultNetwork` 依赖"取不到就返回 null、不臆造半套网络"这条,不能改成抛。
const sgIdCache = new ProcessCache<string>();

// 按名查 bgp-emr-sg 的 SG id(照 dms-service.ts:53 findDmsSgId 范式)。查不到/出错返回 ""(不抛,交由调用方决定)。
async function defaultSgId(targetId: string = HOME_TARGET_ID): Promise<string> {
  if (!isHome(targetId)) {
    throw new Error(
      `platform-env 的默认网络只覆盖 home;target ${targetId} 的子网/SG 应取自其描述符的 resources 袋` +
        `(50 SPEC §1.1;per-target 下发随 P50.3)`
    );
  }
  const key = locationCacheKey(targetId);
  // 🔴 用 peek/set 而不是 resolve():本站点**只缓存正结果**(原语义"查失败不缓存,下次重试"),
  // 走 resolve() 会把负结果也缓存住,行为就变了。
  const hit = sgIdCache.peek(key);
  if (hit) return hit;
  try {
    const r = await ec2.send(
      new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [EMR_DEFAULT_SG_NAME] }] })
    );
    const id = r.SecurityGroups?.[0]?.GroupId || "";
    if (id) sgIdCache.set(key, id); // 与改造前 `if (id) _sgIdCache = id` 逐条一致
    return id;
  } catch {
    return "";
  }
}

/** 单测 / 排障用:清缓存。 */
export function __resetSgIdCache(): void {
  sgIdCache.clear();
}

/**
 * EMR 默认网络(平台环境事实兜底):私有子网(env 注入)+ bgp-emr-sg(按名查)。
 * 子网或 SG 任一取不到 → 返回 null(调用方保持"不带 networkConfiguration"的原行为,不臆造半套网络)。
 * 语义:仅当能凑齐【完整可出网的一套网络】才返回,与 isEmrNetworkFilled(network.ts:16) 的完整性判定对齐。
 */
export async function getEmrDefaultNetwork(): Promise<EmrNetwork | null> {
  const subnetIds = defaultSubnetIds();
  if (!subnetIds.length) return null;
  const sgId = await defaultSgId();
  if (!sgId) return null;
  return { subnetIds, securityGroupIds: [sgId] };
}
