// EMR Serverless application per-作业生命周期（拍板④⑤：不共享，per-作业隔离）。
//
// 每个 EMR 作业一个独立 application（bgp-emr-<jobId 尾段>），彻底无资源争抢/队头阻塞（"尾巴锁"）。
// 由后端动态 Create/Delete：建作业→CreateApplication；删作业→StopApplication+DeleteApplication（零垃圾）。
// application 空闲 autoStop 后不计费，多 application 不烧钱；下次 run 由 ensureStarted 自动拉起。

import { homeRegion } from "@/lib/place/home-region";
import {
  CreateApplicationCommand,
  DeleteApplicationCommand,
  GetApplicationCommand,
  StartApplicationCommand,
  StopApplicationCommand,
  UpdateApplicationCommand,
} from "@aws-sdk/client-emr-serverless";
import type { EmrEngineJob } from "./types";
import { getEmrDefaultNetwork } from "../platform-env";
// per-target 客户端 + per-target 网络事实
import { emrServerlessClientFor } from "@/lib/exec-env/target-clients";
import { HOME_TARGET_ID, assertTargetId, isHome, toTargetSlug } from "@/lib/exec-env/target-id";

// 回落值 = 规格单一作者的缺省(原来写死 emr-7.5.0,与 spec.ts 的缺省漂移成两个作者);env 仍可覆盖(部署期 -c emr-release)。
import { EMR_DEFAULT_RELEASE } from "./spec";
const RELEASE = process.env.EMR_RELEASE_LABEL || EMR_DEFAULT_RELEASE;

/**
 * 该 job 在某个 target 上的 applicationId。
 *
 * 🔴 **home 仍读 `applicationId` 那个老字段**(存量作业一个字不用迁);
 * 非 home 读 `applicationIdByTarget[targetId]`。EMR application 是 **region 作用域**资源 ——
 * 拿 home 那个 id 去 us-west-2 调 GetApplication 只会 ResourceNotFound,
 * 而"找不到就重建"会在**每个区**留下一堆孤儿 application(还在计费)。
 */
export function applicationIdOf(job: EmrEngineJob, targetId: string): string | undefined {
  if (isHome(targetId)) return job.applicationId || undefined;
  const m = (job as { applicationIdByTarget?: Record<string, string> }).applicationIdByTarget || {};
  const v = m[targetId];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** 该 job 名下**全部** application(删作业时要一个不漏地删,否则跨区留孤儿 + 计费)。 */
export function allApplicationRefs(job: EmrEngineJob): Array<{ targetId: string; applicationId: string; region?: string }> {
  const out: Array<{ targetId: string; applicationId: string; region?: string }> = [];
  if (job.applicationId) out.push({ targetId: "tgt_home", applicationId: job.applicationId });
  const m = (job as { applicationIdByTarget?: Record<string, string> }).applicationIdByTarget || {};
  for (const [t, id] of Object.entries(m)) {
    if (typeof id === "string" && id.trim() && !out.some((x) => x.applicationId === id)) out.push({ targetId: t, applicationId: id });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// application 名:home `bgp-emr-<jobId 末12位>`;非 home 带 target slug `bgp-emr-<id12>-<slug>`(EMR application name ≤ 64 字符)。
// 同 region 多 target 各建各的 application(id 已按 `applicationIdByTarget` 分开,
//   名字也分开:两个同名 application 在控制台 / 成本归因里分不清是哪个 target 的)。home 名存量不变。
export function applicationNameFor(jobId: string, targetId: string = HOME_TARGET_ID): string {
  const base = `bgp-emr-${jobId.slice(-12)}`;
  return isHome(targetId) ? base : `${base}-${toTargetSlug(assertTargetId(targetId))}`;
}

// 两个网络配置是否等价（顺序无关比较子网/SG 集合）。
function sameNetwork(a: { subnetIds?: string[]; securityGroupIds?: string[] } | undefined, subnetIds: string[], securityGroupIds: string[]): boolean {
  const sortJoin = (x: string[] = []) => [...x].sort().join(",");
  return sortJoin(a?.subnetIds) === sortJoin(subnetIds) && sortJoin(a?.securityGroupIds) === sortJoin(securityGroupIds);
}

// per-作业创建 application（幂等：已有 applicationId 且存活则复用；但网络/规格变更须同步）。返回 applicationId。
// ⚠️ 关键：application 的 networkConfiguration 必须与作业当前 network 一致——否则 S3 Tables 等需
// 出网访问 s3tables API 的作业会 Connect timed out（见 memory emr-serverless-s3tables-recipe）。
// 由于 application 常在作业刚创建（network 尚空）时就建好，之后用户补填 network，故复用前必须校验并
// UpdateApplication 同步（EMR 允许在 STOPPED 态更新 networkConfiguration）。
/**
 * 该 target 上建 / 用 EMR application 所需的网络事实 —— **唯一作者**(原来 submit 与调度扇出各抄一份,
 * 创建路由那条路**一份都没有** ⇒:给 us-west-2 建的作业在**主控区**先建出一个 application)。
 * 非主控区只取该 target 描述符;主控区返回 null(走平台默认网络 SSOT,逐字节等价)。
 */
export async function targetEmrNetwork(targetId: string): Promise<{ subnetIds: string[]; securityGroupIds: string[] } | null> {
  if (isHome(targetId)) return null;
  const { requireReadyTarget } = await import("@/lib/exec-env/registry");
  const t = await requireReadyTarget(targetId);
  const res = (t.resources ?? {}) as Record<string, unknown>;
  return {
    subnetIds: Array.isArray(res.emrSubnetIds) ? res.emrSubnetIds.map(String) : [],
    securityGroupIds: typeof res.emrSecurityGroupId === "string" ? [res.emrSecurityGroupId] : [],
  };
}

/**
 * targetId → applicationId 投影回作业行的两个字段(主控区写老字段 `applicationId`,存量零迁移;其余进 `applicationIdByTarget`)。
 * 唯一作者:与 `applicationIdOf` / `allApplicationRefs` 读的是同一形状。
 */
export function applicationFields(byTarget: Record<string, string>): { applicationId?: string; applicationIdByTarget?: Record<string, string> } {
  const out: { applicationId?: string; applicationIdByTarget?: Record<string, string> } = {};
  const others: Record<string, string> = {};
  for (const [t, id] of Object.entries(byTarget)) {
    if (isHome(t)) out.applicationId = id;
    else others[t] = id;
  }
  if (Object.keys(others).length) out.applicationIdByTarget = others;
  return out;
}

export async function ensureApplication(
  job: EmrEngineJob,
  // 🔴 落点**必填**(原来可省 = 主控区,创建路由漏传 ⇒ 别区的作业在主控区建 application)
  landing: { targetId: string; region: string; home: boolean },
  /** 该 target 的网络事实(非 home 从描述符 `emrSubnetIds`/`emrSecurityGroupId` 取;唯一作者 targetEmrNetwork) */
  targetNetwork: { subnetIds: string[]; securityGroupIds: string[] } | null
): Promise<string> {
  const targetId = landing.targetId;
  const emr = await emrServerlessClientFor(landing.region);
  const existing = applicationIdOf(job, targetId);
  const spec = job.spec;
  // 网络事实兜底(根治·裂缝A):作业自带 network 优先(用户在页面/顾问选的);未填(如计划中心建的草稿
  // network 恒空)则回退【平台默认网络 SSOT】(私有子网 + bgp-emr-sg)。EMR 读 S3 Tables 必须挂 VPC 出网,
  // 否则 Connect timed out——这是让"网络"回归平台环境事实本位,与 Redshift workgroup 的 env 兜底同款范式。
  // 唯一 choke point:前端/计划中心/调度建 application 全过此函数,一处兜底保所有入口。
  let subnetIds = job.network?.subnetIds || [];
  let securityGroupIds = job.network?.securityGroupIds || [];
  // 🔴 **非 home 绝不回落 home 的子网/SG**:那是**另一个 VPC** 里的 id,EMR 会直接
  //    `Unauthorized/InvalidRequest`(好情况),或者更糟:作业挂进错的网络、连不上该区的 S3/数仓,
  //    错误信息离根因极远。非 home 的网络事实只能来自**该 target 描述符**。
  if (!(subnetIds.length && securityGroupIds.length)) {
    if (landing && !landing.home) {
      if (!(targetNetwork?.subnetIds?.length && targetNetwork?.securityGroupIds?.length)) {
        throw new Error(
          `目标 ${targetId} 缺 EMR 网络事实(emrSubnetIds / emrSecurityGroupId)⇒ 拒绝建 application。` +
            `🔴 刻意不回落 home 的子网:那是另一个 VPC 的 id`
        );
      }
      subnetIds = targetNetwork.subnetIds;
      securityGroupIds = targetNetwork.securityGroupIds;
    } else {
      const fallback = await getEmrDefaultNetwork();
      if (fallback) {
        subnetIds = fallback.subnetIds;
        securityGroupIds = fallback.securityGroupIds;
      }
    }
  }
  const netCfg = subnetIds.length && securityGroupIds.length ? { networkConfiguration: { subnetIds, securityGroupIds } } : {};

  // 已记录 applicationId 且未被删除 → 复用；但先校验网络一致性，不一致则 UpdateApplication 同步。
  if (existing) {
    try {
      const { application } = await emr.send(new GetApplicationCommand({ applicationId: existing }));
      if (application && application.state !== "TERMINATED") {
        // 网络变更（含"从无到有"）→ 更新 application 的 networkConfiguration。
        if (subnetIds.length && securityGroupIds.length && !sameNetwork(application.networkConfiguration, subnetIds, securityGroupIds)) {
          // UpdateApplication 要求 application 处于 STOPPED（或 CREATED）态；先停再更新。
          if (application.state === "STARTED") {
            await emr.send(new StopApplicationCommand({ applicationId: existing }));
            for (let i = 0; i < 20; i++) {
              await sleep(2000);
              const { application: a } = await emr.send(new GetApplicationCommand({ applicationId: existing }));
              if (a?.state === "STOPPED" || a?.state === "CREATED") break;
            }
          }
          await emr.send(new UpdateApplicationCommand({ applicationId: existing, networkConfiguration: { subnetIds, securityGroupIds } }));
        }
        return existing;
      }
    } catch {
      /* 不存在 → 往下重建 */
    }
  }
  const { applicationId } = await emr.send(
    new CreateApplicationCommand({
      name: applicationNameFor(job.jobId, targetId),
      releaseLabel: spec?.releaseLabel || RELEASE,
      type: "SPARK",
      architecture: spec?.architecture || "ARM64",
      // 连接信息（拍板③前置填清）：私有子网 + SG。只有填了才带 networkConfiguration。
      ...netCfg,
      autoStartConfiguration: { enabled: true },
      autoStopConfiguration: { enabled: true, idleTimeoutMinutes: 15 }, // 空闲自动停，控成本
      // 🔴 tag 带上 targetId:一个作业在多个区各有一个 application,不带 target 就分不清谁是谁
      tags: { "bgp:jobId": job.jobId, "bgp:managed": "true", "bgp:targetId": targetId },
    })
  );
  if (!applicationId) throw new Error("CreateApplication 未返回 applicationId");
  return applicationId;
}

// 确保 application 处于可提交状态（CREATED/STOPPED → StartApplication → 等到 STARTED）。
export async function ensureStarted(applicationId: string, region?: string): Promise<void> {
  // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
  const emr = await emrServerlessClientFor(region || homeRegion());
  const { application } = await emr.send(new GetApplicationCommand({ applicationId }));
  const state = application?.state;
  if (state === "STARTED") return;
  if (state === "CREATED" || state === "STOPPED") {
    await emr.send(new StartApplicationCommand({ applicationId }));
  }
  // 轮询到 STARTED（CREATING/STARTING 也在此等待）。最多 ~60s。
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const { application: a } = await emr.send(new GetApplicationCommand({ applicationId }));
    if (a?.state === "STARTED") return;
    if (a?.state === "STOPPED") {
      await emr.send(new StartApplicationCommand({ applicationId }));
    }
  }
  throw new Error(`EMR application ${applicationId} 未能在超时内进入 STARTED`);
}

// 删作业时回收 application（先 Stop 再 Delete；已不存在则静默）。零垃圾。
export async function destroyApplication(applicationId?: string, region?: string): Promise<void> {
  if (!applicationId) return;
  // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
  const emr = await emrServerlessClientFor(region || homeRegion());
  try {
    await emr.send(new StopApplicationCommand({ applicationId }));
  } catch {
    /* 可能已 STOPPED/不存在 */
  }
  // Stop 后需等状态离开 STARTED/STOPPING 才能 Delete；简单重试。
  for (let i = 0; i < 15; i++) {
    try {
      await emr.send(new DeleteApplicationCommand({ applicationId }));
      return;
    } catch {
      await sleep(2000);
    }
  }
  // 最后一搏（抛出让调用方 fire-and-forget 吞掉）。
  await emr.send(new DeleteApplicationCommand({ applicationId }));
}
