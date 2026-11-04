// 序 61 B-133 —— 数据源依赖的**外部网络对象**(平台自建安全组 / 平台探测选的子网 / Glue 连接 / 凭证密钥)的漂移核对与自愈(唯一作者)。
//
// 【缺陷原形(2026-10-28 测试账号真撞)】平台为数据源自建的组 `bgp-ds-*` 只在 Glue 作业跑时才挂网卡,其余时间零网卡;任何按
//   「无网卡即孤儿」清理的人或工具都会删它(这次是操作者按 Description 猜归属删错)。删掉之后:该源每次同步 / 定时运行都失败,
//   运行行写的是 AWS 原话「Security Group Not Found …」;数据源列表仍显示「已连接」;编辑不重建组,删了重建会让任务成孤儿(B-131);
//   产品里没有任何修复入口。同步作业定义与脚本早已是「每次启动按当前定义重建」,数据源这一层是唯一例外。
// 【模型】按**归属**分两类,调用方只认闭合结果:
//   · 平台拥有(自建组 / Glue 连接 / 平台探测选的子网):可由源行 + 密钥完整重建 ⇒ **在使用时刻**按原规则重建并接回(`healed`),
//     写审计 `datasource.network.healed` + 告警中心事件 + 源行 `healCount / lastHealedAt` —— 自愈必须响亮,否则账号里那个清理工具
//     一直删、平台一直补,没人知道根子在哪;
//   · 用户拥有(B-54 指定的组 / 子网)、密钥内容、VPC:一个不碰 ⇒ `broken`,源行 status=error + networkIssue,运行拒绝(409
//     `DATASOURCE_NETWORK_BROKEN`),文案点名对象并指到「编辑数据源 → 网络配置 / 重填口令」。
//   · 事实读不到(限流 / 权限)⇒ `unverifiable`,**不拦业务**,只记日志(Glue 自己会报;读失败不该阻断同步)。
// 【调用点】`lib/sync/start-run.ts ensureGlueSyncJob`(启动 / 保存 / 补数共用,任何副作用之前)· `lib/datasource/glue-reach.ts startDiscovery`
//   (探测 / 浏览表)· `lib/scheduler/dependency.ts startDownstreamSync`(上游成功扇出)· `lib/datasource/network-sweep.ts`(泵每 10 分钟
//   巡检一轮,覆盖不经 TS 启动核心的调度运行时路径,并在没人用之前就发现漂移)。棘轮:`lib/sync/__tests__/start-job-run-preflight-ratchet.test.ts`。
// 【幂等 / 并发】建组复用 `createPlatformDsSecurityGroup` 的 InvalidGroup.Duplicate 分支(同名已有 ⇒ 复用);UpdateConnection 幂等;
//   源行写用 `patchDataSourceRow` 条件写(源已删即丢弃,B-132)。两路同时自愈最多多一次 Describe,不会建出两个组。
// 【多区】按源的落点(`ownerTargetId`)在该区做,凭证经落点取得,不回落主控区。读路径(列表 / 详情)不调本模块(零 EC2 调用)。
import type { DataSource } from "@/types/datasource";
import { targetOfStamp } from "@/lib/exec-env/target-id";
import { resolveDsPlace, noteDatasourceRowPlace, type DsPlaceResolved } from "@/lib/datasource/ds-place";
import { patchDataSourceRow } from "@/lib/datasource/ds-patch";
import {
  createPlatformDsSecurityGroup,
  createGlueConnection,
  updateGlueConnectionNetwork,
  getGlueConnectionNetwork,
  describeSecurityGroupsById,
  describeSubnetFact,
  tagPlatformDsSecurityGroup,
  probeNetwork,
  isUserNetworkConfig,
  glueSecurityGroupIds,
  PLATFORM_DS_MANAGED_TAG_KEY,
  platformGlueConnectionName,
  type NetworkConfig,
  type UserNetworkConfig,
} from "@/lib/aws/datasource-service";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { writeAuditRecord, type AuditActorRef } from "@/lib/audit";
import { putEventIfNew } from "@/lib/alerting/events";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
import { logger } from "@/lib/observability/logger";
import { classifyRunError, isNetworkDrift, type RunErrorClassification } from "@/lib/sync/run-error";

export type DriftObject = "security-group" | "subnet" | "glue-connection" | "secret";

export interface NetworkIssue {
  object: DriftObject;
  objectId?: string;
  /** true = 用户自带(平台不代建);false = 平台拥有但自愈失败 */
  userOwned: boolean;
  message: string;
  at: string;
}

export interface HealedItem {
  object: DriftObject;
  from?: string;
  to?: string;
}

export type NetworkReconcileOutcome =
  | { kind: "intact"; skipped?: string }
  | { kind: "healed"; healed: HealedItem[]; message: string; healCount: number }
  | { kind: "broken"; issue: NetworkIssue; message: string }
  | { kind: "unverifiable"; reason: string };

/** 告警中心「虚拟规则」id(事件表 + 通道复用;与 cred-observability / finops 同一惯例) */
export const NETWORK_DRIFT_ALERT_RULE_ID = "datasource-network-drift";
export const NETWORK_DRIFT_ALERT_RULE_NAME = "数据源网络对象被平台外删除";
/** 请求外(泵巡检 / 调度扇出)写审计用的系统身份 */
export const NETWORK_RECONCILE_SYSTEM_ACTOR: AuditActorRef = { actor: "system:datasource-network-reconcile" };
export const AUDIT_ACTION_HEALED = "datasource.network.healed";
export const AUDIT_ACTION_BROKEN = "datasource.network.broken";

/** 调用方(探测路径)要把 broken 当成可读失败抛出时用的错误类型(code 与 API 错误码同词)。 */
export class DatasourceNetworkBrokenError extends Error {
  readonly code = "DATASOURCE_NETWORK_BROKEN" as const;
  constructor(readonly issue: NetworkIssue) {
    super(issue.message);
    this.name = "DatasourceNetworkBrokenError";
  }
}

export interface ReconcileOptions {
  /** 从哪条路来(审计 / 日志 / 告警里的归因):sync.ensure-job · ds.discovery · scheduler.dependency · sweep */
  via: string;
  /** 请求内的操作者;请求外不传 ⇒ 系统身份 */
  actor?: AuditActorRef;
}

type Nc = NetworkConfig | UserNetworkConfig;

/** 核对需要的源行字段(调用方拿到的可能是 DataSource 全行,也可能是 glue-reach 的 Pick;name 等只用于文案 / 归因) */
export type ReconcileDs = Pick<DataSource, "datasourceId" | "type" | "host" | "port" | "database" | "secretArn" | "glueConnectionName" | "ownerTargetId" | "jdbcParams" | "networkConfig"> &
  Partial<Pick<DataSource, "name" | "networkState" | "networkIssue" | "healCount">>;
type DsNamed = Pick<DataSource, "datasourceId"> & { name?: string };

function dsName(ds: DsNamed): string {
  return ds.name || ds.datasourceId;
}

function dsProjectId(ds: ReconcileDs): string {
  const p = (ds as { projectId?: unknown }).projectId;
  return typeof p === "string" && p ? p : "proj-default";
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

function errText(e: unknown): string {
  return sanitizeAwsErrorMessage(String((e as Error)?.message ?? e));
}

function isSecretMissing(e: unknown): boolean {
  const name = String((e as { name?: string })?.name ?? "");
  const msg = String((e as Error)?.message ?? "");
  return name === "ResourceNotFoundException" || /can't find the specified secret|Secrets Manager can.t find/i.test(msg);
}

/** 用户看到的那句话(409 文案 / 源行 networkIssue.message / 告警 message 同一份)。 */
export function networkIssueMessage(ds: DsNamed, issue: Omit<NetworkIssue, "message" | "at">, detail?: string): string {
  const n = dsName(ds);
  const id = issue.objectId ? ` ${issue.objectId}` : "";
  switch (issue.object) {
    case "security-group":
      return issue.userOwned
        ? `数据源「${n}」指定的安全组${id} 已不存在,它不是平台建的,平台不会代建;请在「数据源 → 编辑 → 网络配置」换一个安全组,或由账号管理员恢复后再启动`
        : `数据源「${n}」的平台安全组${id} 已不存在(被平台外删除),自动重建失败${detail ? `:${detail}` : ""};请稍后重试,仍失败请联系平台管理员`;
    case "subnet":
      return issue.userOwned
        ? `数据源「${n}」指定的子网${id} 已不存在,它不是平台建的,平台不会代建;请在「数据源 → 编辑 → 网络配置」换一个子网`
        : `数据源「${n}」的子网${id} 已不存在(被平台外删除),自动重选子网失败${detail ? `:${detail}` : ""};请在「数据源 → 编辑 → 网络配置」手工指定`;
    case "glue-connection":
      return `数据源「${n}」的 Glue 连接${id} 已不存在(被平台外删除),按源行与凭证重建失败${detail ? `:${detail}` : ""};请稍后重试`;
    case "secret":
      return `数据源「${n}」的凭证密钥已不存在,平台无法重建 Glue 连接;请在「数据源 → 编辑」重新输入账号口令`;
    default:
      return `数据源「${n}」的网络对象缺失${detail ? `:${detail}` : ""}`;
  }
}

async function settleBroken(ds: ReconcileDs, place: DsPlaceResolved | null, partial: Omit<NetworkIssue, "message" | "at">, opts: ReconcileOptions, detail?: string): Promise<NetworkReconcileOutcome> {
  const prev = ds.networkIssue;
  if (ds.networkState === "broken" && prev && prev.object === partial.object && (prev.objectId ?? null) === (partial.objectId ?? null) && prev.userOwned === partial.userOwned) {
    // 同一个缺口已经落过源行 / 审计 / 告警(告警 dedupeKey 也相同)⇒ 不重复写,只把结论原话还给调用方
    //   (巡检每 10 分钟一轮、用户可能连点「启动」,都不许刷审计;缺口变了(别的对象 / 别的 id)才重新落一遍)。
    return { kind: "broken", issue: prev, message: prev.message };
  }
  const issue: NetworkIssue = { ...partial, message: networkIssueMessage(ds, partial, detail), at: new Date().toISOString() };
  // 源行:状态诚实 —— 不许再显示「已连接」
  await patchDataSourceRow(ds.datasourceId, { networkState: "broken", networkIssue: issue, status: "error" }).catch((e) =>
    logger.warn("datasource.network.broken.persist-failed", { datasourceId: ds.datasourceId, error: errText(e) })
  );
  try {
    await writeAuditRecord(opts.actor ?? NETWORK_RECONCILE_SYSTEM_ACTOR, AUDIT_ACTION_BROKEN, {
      resourceType: "datasource",
      resourceId: ds.datasourceId,
      ...(place ? { targetId: place.targetId } : {}),
      detail: { via: opts.via, name: ds.name, object: issue.object, objectId: issue.objectId ?? null, userOwned: issue.userOwned, message: issue.message },
    });
  } catch (e) {
    logger.warn("datasource.network.broken.audit-failed", { datasourceId: ds.datasourceId, error: errText(e) });
  }
  try {
    await putEventIfNew({
      ruleId: NETWORK_DRIFT_ALERT_RULE_ID,
      ruleName: NETWORK_DRIFT_ALERT_RULE_NAME,
      severity: "P1",
      projectId: dsProjectId(ds),
      dedupeKey: `broken#${ds.datasourceId}#${issue.object}#${issue.objectId ?? "-"}`,
      message: issue.message,
      trigger: { taskId: ds.datasourceId, taskName: dsName(ds), taskType: "datasource-network-drift", ...(place ? { targetId: place.targetId } : {}) },
    });
  } catch (e) {
    logger.warn("datasource.network.broken.alert-failed", { datasourceId: ds.datasourceId, error: errText(e) });
  }
  logger.warn("datasource.network.broken", { datasourceId: ds.datasourceId, via: opts.via, object: issue.object, objectId: issue.objectId, userOwned: issue.userOwned });
  return { kind: "broken", issue, message: issue.message };
}

/**
 * 核对并自愈一条数据源依赖的外部网络对象。调用方按 `kind` 决定:
 *   intact / healed / unverifiable ⇒ 照常往下走(healed 已落审计与告警);broken ⇒ 拒绝并把 `message` 原话给用户。
 * 🔴 读失败不拦业务;写失败(重建 / 接回)⇒ broken(userOwned=false),原因进文案。
 */
export async function reconcileDatasourceNetwork(ds: ReconcileDs, opts: ReconcileOptions): Promise<NetworkReconcileOutcome> {
  noteDatasourceRowPlace(ds);
  const nc = ds.networkConfig as Nc | undefined;
  if (!ds.glueConnectionName || !nc || !nc.subnetId || !isDataSourceType(ds.type) || getProvider(ds.type).capabilities.paradigm !== "jdbc") {
    return { kind: "intact", skipped: "non-jdbc-or-no-network-config" };
  }
  let place: DsPlaceResolved;
  try {
    place = await resolveDsPlace(targetOfStamp(ds.ownerTargetId));
  } catch (e) {
    return { kind: "unverifiable", reason: `落点解析失败:${errText(e)}` };
  }
  const region = place.region;
  const userOwned = isUserNetworkConfig(nc);
  const expectedSgs = glueSecurityGroupIds(nc);

  // ① 读事实(并行,只读;任何一项读失败 ⇒ unverifiable,不拦业务)
  let sgFacts: Awaited<ReturnType<typeof describeSecurityGroupsById>>;
  let subnetFact: Awaited<ReturnType<typeof describeSubnetFact>>;
  let conn: Awaited<ReturnType<typeof getGlueConnectionNetwork>>;
  try {
    [sgFacts, subnetFact, conn] = await Promise.all([
      describeSecurityGroupsById(expectedSgs, region),
      describeSubnetFact(nc.subnetId, region),
      getGlueConnectionNetwork(ds.glueConnectionName, region),
    ]);
  } catch (e) {
    const reason = `读取网络对象事实失败(${region}):${errText(e)}`;
    logger.warn("datasource.network.unverifiable", { datasourceId: ds.datasourceId, via: opts.via, reason });
    return { kind: "unverifiable", reason };
  }

  const healed: HealedItem[] = [];
  const subnetOk = subnetFact !== null;
  // 🔴 B-133 第二刀:源行的 networkConfig 不存可用区(建源落库从没写过)⇒ 重建 / 接回连接时 AZ 以**子网事实**为准;
  //   这里只是让落回源行的 networkConfig 也带上它,真正的写连接作者(createGlueConnection / updateGlueConnectionNetwork)自己再按子网核一次
  let next: Nc = { ...nc, ...(subnetFact ? { availabilityZone: subnetFact.availabilityZone } : {}) };

  // ② 子网(先于安全组:子网重选可能落到另一个 VPC,组必须建在同一个 VPC 里 —— Glue 连接不能引用跨 VPC 的组)
  if (!subnetOk) {
    if (userOwned) {
      return settleBroken(ds, place, { object: "subnet", objectId: nc.subnetId, userOwned: true }, opts);
    }
    try {
      // 与建源时同一探测过程(RDS 子网组 / 该区描述符里的私有子网 / 主控区部署快照)
      const probe = await probeNetwork(String(ds.host ?? ""), place);
      next = { ...next, vpcId: probe.vpcId, subnetId: probe.subnetId, ...(probe.availabilityZone ? { availabilityZone: probe.availabilityZone } : {}) };
      healed.push({ object: "subnet", from: nc.subnetId, to: probe.subnetId });
    } catch (e) {
      return settleBroken(ds, place, { object: "subnet", objectId: nc.subnetId, userOwned: false }, opts, errText(e));
    }
  }

  // ③ 安全组:缺 ⇒ 平台的按源行在(可能已换的)VPC 里重建;在但 VPC 换了 ⇒ 同样重建(旧组留给 B-130 的清理路径不在本模块职责内);
  //   在且 VPC 没换 ⇒ 存量平台组无归属标签时顺手补上
  const missingSgs = expectedSgs.filter((id) => !sgFacts.has(id));
  const vpcChanged = next.vpcId !== nc.vpcId;
  if (missingSgs.length || (vpcChanged && !userOwned)) {
    if (userOwned) {
      return settleBroken(ds, place, { object: "security-group", objectId: missingSgs.join(", "), userOwned: true }, opts);
    }
    try {
      const newId = await createPlatformDsSecurityGroup({ vpcId: next.vpcId, dbType: ds.type, datasourceId: ds.datasourceId, region, targetId: place.targetId });
      healed.push({ object: "security-group", from: nc.securityGroupId, to: newId });
      next = { ...next, securityGroupId: newId };
    } catch (e) {
      return settleBroken(ds, place, { object: "security-group", objectId: nc.securityGroupId, userOwned: false }, opts, errText(e));
    }
  } else if (!userOwned) {
    // 存量平台组(2.1.2 及之前建的)没有归属标签 ⇒ 顺手补上(幂等;失败只记日志,不影响本次结论)
    const fact = sgFacts.get(nc.securityGroupId);
    if (fact && !(PLATFORM_DS_MANAGED_TAG_KEY in fact.tags)) {
      try {
        await tagPlatformDsSecurityGroup(nc.securityGroupId, ds.datasourceId, place.targetId, region);
      } catch (e) {
        logger.warn("datasource.network.tag-failed", { datasourceId: ds.datasourceId, sgId: nc.securityGroupId, error: errText(e) });
      }
    }
  }

  // ④ Glue 连接:不存在 ⇒ 由源行 + 密钥重建;存在但引用的组 / 子网与期望不一致 ⇒ 接回
  const wantSgs = glueSecurityGroupIds(next);
  if (!conn.exists) {
    // 重建只能按平台命名规则建(createGlueConnection 内部派生名字);源行记的名字若与规则不一致,建出来的也接不回作业 ⇒ 如实 broken,不建
    if (ds.glueConnectionName !== platformGlueConnectionName(ds.datasourceId)) {
      return settleBroken(ds, place, { object: "glue-connection", objectId: ds.glueConnectionName, userOwned: false }, opts, `源行记的连接名与平台命名规则(${platformGlueConnectionName(ds.datasourceId)})不一致,不代建`);
    }
    try {
      await createGlueConnection(ds.datasourceId, ds.type, String(ds.host ?? ""), Number(ds.port ?? 0), String(ds.database ?? ""), String(ds.secretArn ?? ""), next, region, ds.jdbcParams);
      healed.push({ object: "glue-connection", to: ds.glueConnectionName });
    } catch (e) {
      if (isSecretMissing(e)) return settleBroken(ds, place, { object: "secret", objectId: ds.secretArn, userOwned: true }, opts);
      return settleBroken(ds, place, { object: "glue-connection", objectId: ds.glueConnectionName, userOwned: false }, opts, errText(e));
    }
  } else if (!sameSet(conn.securityGroupIds, wantSgs) || conn.subnetId !== next.subnetId) {
    try {
      await updateGlueConnectionNetwork(ds.glueConnectionName, { subnetId: next.subnetId, securityGroupIds: wantSgs, availabilityZone: next.availabilityZone }, region);
      healed.push({ object: "glue-connection", from: `${conn.subnetId ?? "?"} / ${conn.securityGroupIds.join("+") || "-"}`, to: `${next.subnetId} / ${wantSgs.join("+")}` });
    } catch (e) {
      return settleBroken(ds, place, { object: "glue-connection", objectId: ds.glueConnectionName, userOwned: false }, opts, errText(e));
    }
  }

  if (!healed.length) {
    // 之前标过 broken、现在对象都在(有人在账号里恢复了)⇒ 把结论改回来,不让「网络对象缺失」永久挂着
    if (ds.networkState === "broken") {
      await patchDataSourceRow(ds.datasourceId, { networkState: "intact", networkIssue: null }).catch(() => undefined);
    }
    return { kind: "intact" };
  }

  // ⑤ 自愈落库 + 审计 + 告警(响亮)
  const at = new Date().toISOString();
  const healCount = (typeof ds.healCount === "number" ? ds.healCount : 0) + 1;
  const list = healed.map((h) => `${h.object}${h.from ? ` ${h.from}` : ""} → ${h.to ?? "?"}`).join(";");
  const message = `数据源「${dsName(ds)}」的平台网络对象被平台外删除,已自动重建并接回(${list};累计 ${healCount} 次)。请排查账号里是否有清理工具在删除带 ${PLATFORM_DS_MANAGED_TAG_KEY} 标签的对象`;
  const persisted = await patchDataSourceRow(ds.datasourceId, { networkConfig: next, networkState: "healed", networkIssue: null, healCount, lastHealedAt: at }).catch((e) => {
    logger.warn("datasource.network.healed.persist-failed", { datasourceId: ds.datasourceId, error: errText(e) });
    return "failed" as const;
  });
  try {
    await writeAuditRecord(opts.actor ?? NETWORK_RECONCILE_SYSTEM_ACTOR, AUDIT_ACTION_HEALED, {
      resourceType: "datasource",
      resourceId: ds.datasourceId,
      targetId: place.targetId,
      detail: { via: opts.via, name: ds.name, healed, healCount, persisted },
    });
  } catch (e) {
    logger.warn("datasource.network.healed.audit-failed", { datasourceId: ds.datasourceId, error: errText(e) });
  }
  try {
    await putEventIfNew({
      ruleId: NETWORK_DRIFT_ALERT_RULE_ID,
      ruleName: NETWORK_DRIFT_ALERT_RULE_NAME,
      severity: "P2",
      projectId: dsProjectId(ds),
      dedupeKey: `heal#${ds.datasourceId}#${at}`,
      message,
      trigger: { taskId: ds.datasourceId, taskName: dsName(ds), taskType: "datasource-network-drift", metricValue: healCount, targetId: place.targetId },
    });
  } catch (e) {
    logger.warn("datasource.network.healed.alert-failed", { datasourceId: ds.datasourceId, error: errText(e) });
  }
  logger.warn("datasource.network.healed", { datasourceId: ds.datasourceId, via: opts.via, healed, healCount });
  return { kind: "healed", healed, message, healCount };
}

/**
 * 运行终态的错误被分类成「网络漂移」时(核对与 StartJobRun 之间对象被删、或不经 TS 启动核心的调度运行时路径)⇒ 把源行标 broken,
 * 下一次启动前 `reconcileDatasourceNetwork` 会自愈。只在分类命中时写;调用方 fire-and-forget。
 */
export async function noteNetworkDriftFromRunError(ds: Pick<DataSource, "datasourceId">, raw: string | null | undefined): Promise<RunErrorClassification> {
  const cls = classifyRunError(raw);
  if (!isNetworkDrift(cls.kind)) return cls;
  const object: DriftObject = cls.kind === "network-drift-security-group" ? "security-group" : cls.kind === "network-drift-subnet" ? "subnet" : "glue-connection";
  const issue: NetworkIssue = { object, objectId: cls.objectId, userOwned: false, message: cls.message, at: new Date().toISOString() };
  await patchDataSourceRow(ds.datasourceId, { networkState: "broken", networkIssue: issue }).catch((e) =>
    logger.warn("datasource.network.drift-from-run.persist-failed", { datasourceId: ds.datasourceId, error: errText(e) })
  );
  return cls;
}
