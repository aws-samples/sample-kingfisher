// DMS 通道(全量 / 增量 CDC / 实时)的**落点唯一作者**。
//
// 【为什么存在】2026-11 之前 DMS 通道只在主控区:服务层握着模块级的主控区客户端,复制实例名 / 子网组 / 安全组名 / 访问角色
//   来自环境变量或字面缺省;非主控区数据源的任务能选、能存,启动才被拒。逐区下推之后「在哪个区建实例、建端点、
//   写哪个区的数仓、用哪个区的密钥」必须只有一个答案,而且这个答案来自**任务自己的绑定**,不是谁的缺省值。
//
// 两级:
//   · `DmsSite`  —— 只要「哪个区、哪台复制实例」:停止 / 删除 / 读状态 / 回收用。目标不在「就位」态也要能解析
//     (正在停止承接的执行区里的通道照样得停得下来),所以这里**不做准入判定**,只解析位置。
//   · `DmsPlace` —— 启动要的全部事实(子网组 · 安全组名 · 访问角色 · 暂存桶 · 数仓 · 目标密钥名)。要求目标已就位且装了
//     DMS 组件;缺任何一项 ⇒ 抛 `DmsPlaceUnavailable`,原因写清缺什么、去哪补。
//
// 🔴 类型上堵死「忘了带落点」:两个类型都带品牌,产品代码里只有本文件造得出来;服务层每个发云调用的函数第一个参数就是它,
//   没有缺省 —— 漏传是编译错,不是「静默打到主控区」。
// 🔴 主控区与执行区同一条路:主控区的名字来自同一份命名单一事实源(`bgp-dms` / `bgp-dms-sg` / `bgp-dms-subnet-group`,与此前的
//   字面缺省逐字相同),访问角色取平台容器的 `DMS_ROLE_ARN`(主控区栈固定名角色;这个环境变量的读点只留这一处)。
import { resourceName } from "@/lib/aws/naming";
import { assertTargetComponent, bindingTargets } from "@/lib/exec-env/data-plane-target";
import { assertPerTargetExecRole } from "@/lib/exec-env/exec-roles";
import { requireReadyTarget, type ExecutionTarget } from "@/lib/exec-env/registry";
import { resolveTargetGlue, resolveTargetWarehouse, type TargetWarehouse } from "@/lib/exec-env/target-clients";
import { isHome } from "@/lib/exec-env/target-id";
import { regionOfTarget } from "@/lib/exec-env/target-region";
import { notePlaceDecision } from "@/lib/place/context";
import { DMS_TARGET_SECRET_NAME } from "@/lib/realtime/dms-ingest-identity";

/** 落点决策账本里的作者名(观测清单按它归类)。 */
export const DMS_PLACE_VIA = "resolveDmsPlace";

declare const dmsSiteBrand: unique symbol;

/** DMS 通道在哪个区、用哪台复制实例。 */
export interface DmsSite {
  readonly [dmsSiteBrand]: true;
  readonly targetId: string;
  readonly region: string;
  /** 复制实例标识(每区一台,产品懒创建、空闲回收)。 */
  readonly instanceId: string;
}

/** 启动一条 DMS 通道要的全部位置事实。 */
export interface DmsPlace extends DmsSite {
  /** 复制子网组(执行环境栈交付)。 */
  readonly subnetGroupId: string;
  /** 复制实例的安全组名(执行环境栈交付;用的时候按名在本区查 id)。 */
  readonly securityGroupName: string;
  /** DMS 读密钥 / 写暂存桶 / 数仓 COPY 用的访问角色。 */
  readonly roleArn: string;
  /** DMS → 数仓的暂存桶(本区数据湖桶)。 */
  readonly stagingBucket: string;
  /** 目标数仓(本区)。 */
  readonly warehouse: TargetWarehouse;
  /** 目标数仓专用用户的密钥名(本区)。 */
  readonly targetSecretName: string;
}

export type DmsPlaceUnavailableReason = "multi-binding" | "not-ready" | "missing-component" | "missing-resource";

/**
 * 这条任务的 DMS 落点解析不出来 / 该区还不具备跑 DMS 通道的条件。全是**可修**的原因,消息里写明去哪修。
 * `httpStatus`:绑定本身有问题(多绑定)⇒ 409;该区基建没就位 ⇒ 503。
 */
export class DmsPlaceUnavailable extends Error {
  constructor(
    readonly reason: DmsPlaceUnavailableReason,
    readonly targetId: string,
    message: string
  ) {
    super(message);
    this.name = "DmsPlaceUnavailable";
  }
  get httpStatus(): 409 | 503 {
    return this.reason === "multi-binding" ? 409 : 503;
  }
}

type BoundRow = { targets?: unknown; targetId?: unknown } | null | undefined;

/** 任务绑定的那**一个**执行区(同步任务 = 读源写仓,源在哪个区任务就在哪个区;绑了多个区 ⇒ 不知道通道该建在哪 ⇒ 拒)。 */
export function dmsTargetOfTask(task: BoundRow): string {
  const bound = bindingTargets(task);
  if (bound.length !== 1) {
    throw new DmsPlaceUnavailable(
      "multi-binding",
      bound.join(" / "),
      `该任务绑定了 ${bound.length} 个执行环境(${bound.join(" / ")}),而一条 DMS 通道只能建在一个区 ⇒ 拒绝;请为每个区各建一条同步任务`
    );
  }
  return bound[0];
}

function site(targetId: string, region: string): DmsSite {
  return { targetId, region, instanceId: resourceName("dmsInstanceId", { targetId }) } as DmsSite;
}

/**
 * 按执行区解析「哪个区、哪台复制实例」。不做准入判定(见文件头);区解析本身会记落点决策。
 * @throws `TargetBindingRejected` / 注册表读不到时的原错误 —— 调用方按「不知道它在哪跑」处理,绝不当成「没东西可停」。
 */
export async function resolveDmsSiteOfTarget(targetId: string): Promise<DmsSite> {
  const region = await regionOfTarget(targetId);
  notePlaceDecision({ targetId, via: DMS_PLACE_VIA });
  return site(targetId, region);
}

/** 按任务绑定解析「哪个区、哪台复制实例」。 */
export async function resolveDmsSite(task: BoundRow): Promise<DmsSite> {
  return resolveDmsSiteOfTarget(dmsTargetOfTask(task));
}

function requireResource(t: ExecutionTarget, key: string, what: string): string {
  const v = (t.resources ?? {})[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new DmsPlaceUnavailable(
      "missing-resource",
      t.targetId,
      `执行环境 ${t.targetId} 的实时基建不完整:缺${what}(${key})⇒ 请在「执行环境」页对它点「重新部署」后再启动`
    );
  }
  return v;
}

/**
 * 按任务绑定解析启动 DMS 通道要的全部事实。
 * @throws `DmsPlaceUnavailable`(可修,消息指路)
 */
export async function resolveDmsPlace(task: BoundRow): Promise<DmsPlace> {
  const targetId = dmsTargetOfTask(task);
  if (isHome(targetId)) {
    const roleArn = process.env.DMS_ROLE_ARN || "";
    if (!roleArn) {
      throw new DmsPlaceUnavailable("missing-resource", targetId, "实时基建未就绪:请先部署 BgpRealtimeStack(-c enable-realtime=1)");
    }
    const home = { targetId } as unknown as ExecutionTarget;
    const base = await resolveDmsSiteOfTarget(targetId);
    return {
      ...base,
      subnetGroupId: resourceName("dmsSubnetGroup", { targetId }),
      securityGroupName: resourceName("dmsSecurityGroup", { targetId }),
      roleArn,
      stagingBucket: resolveTargetGlue(home).datalakeBucket,
      warehouse: resolveTargetWarehouse(home),
      targetSecretName: DMS_TARGET_SECRET_NAME,
    } as DmsPlace;
  }
  let t: ExecutionTarget;
  try {
    t = await requireReadyTarget(targetId);
  } catch (e) {
    throw new DmsPlaceUnavailable("not-ready", targetId, `执行环境 ${targetId} 当前不可用 ⇒ 拒绝启动:${String((e as Error)?.message ?? e).slice(0, 240)}`);
  }
  try {
    assertTargetComponent(t, "dms");
  } catch (e) {
    throw new DmsPlaceUnavailable("missing-component", targetId, String((e as Error)?.message ?? e).slice(0, 300));
  }
  const subnetGroupId = requireResource(t, "dmsSubnetGroup", "复制子网组");
  let roleArn: string;
  try {
    roleArn = assertPerTargetExecRole(t, "dmsKinesisRoleArn");
  } catch (e) {
    throw new DmsPlaceUnavailable(
      "missing-resource",
      targetId,
      `执行环境 ${targetId} 的实时基建不完整:${String((e as Error)?.message ?? e).slice(0, 200)} ⇒ 请在「执行环境」页对它点「重新部署」后再启动`
    );
  }
  const stagingBucket = requireResource(t, "datalakeBucket", "数据湖桶");
  let warehouse: TargetWarehouse;
  try {
    warehouse = resolveTargetWarehouse(t);
  } catch (e) {
    throw new DmsPlaceUnavailable("missing-resource", targetId, String((e as Error)?.message ?? e).slice(0, 300));
  }
  // 准入之后才记(被拒的请求不许被归到某个区)
  const base = await resolveDmsSiteOfTarget(targetId);
  return {
    ...base,
    subnetGroupId,
    securityGroupName: resourceName("dmsSecurityGroup", { targetId }),
    roleArn,
    stagingBucket,
    warehouse,
    targetSecretName: DMS_TARGET_SECRET_NAME,
  } as DmsPlace;
}

/**
 * 🔴 只给判据用:手工造一个落点(判据不想为了测服务层把整个注册表搭起来)。产品代码不许引用 —— 有棘轮盯着。
 */
export function __dmsPlaceForTest(fields: Omit<DmsPlace, typeof dmsSiteBrand>): DmsPlace {
  return { ...fields } as DmsPlace;
}
