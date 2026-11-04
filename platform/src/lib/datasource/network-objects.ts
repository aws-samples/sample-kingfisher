// 系统设置「数据源网络对象」清单与孤儿清理(唯一作者;路由只做鉴权与整形)。
//
// 【为什么要有】平台为数据源自建的安全组 `bgp-ds-*` 只在 Glue 作业跑时才挂网卡,其余时间零网卡;账号里任何按「无网卡即孤儿」清理的人或工具
//   都会把它删掉(2026-10-28 测试账号真撞)。产品里原来既看不到「哪些组是平台的、归谁、在不在用」,也没有清理真孤儿的入口 ⇒
//   人只能靠猜(猜错就是该缺陷的事故)。这里把事实摆出来:每个区所有平台组(组名 bgp-ds-* ∪ 带 bgp:managed 标签)× 归属源 × 在用 / 孤儿 /
//   待清理 × 网卡数;孤儿一键清理走该缺陷的持久清理作业(按网卡事实收口),**不在请求里直接 DeleteSecurityGroup**。
// 【归属判定】源行 networkConfig 的 securityGroupId / securityGroupIds[] / platformSecurityGroupId 引用到 ⇒ 在用(谁引用都算,包括用户指定路径);
//   标签 bgp:datasourceId 只作展示与清理作业的 datasourceId,不作在用判定(标签可被改,源行才是事实)。
// 【只读 / 写】清单是只读(Describe + 一次 Scan);清理 = 服务端**重新**核三条件(平台组 + 无源行引用 + 网卡 0)后入队,审计由路由写。
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { listTargetsRaw } from "@/lib/exec-env/registry";
import { listJobsByTarget } from "@/lib/dataplane-jobs/store";
import { isTerminalPhase } from "@/lib/dataplane-jobs/model";
import { enqueueSgCleanup } from "@/lib/datasource/sg-cleanup-job";
import {
  listPlatformDsSecurityGroups, describeSecurityGroupsById, countNetworkInterfacesInSecurityGroup,
  PLATFORM_DS_SG_PREFIX, PLATFORM_DS_MANAGED_TAG_KEY, PLATFORM_DS_MANAGED_TAG_VALUE, PLATFORM_DS_OWNER_TAG_KEY,
  type SecurityGroupFact,
} from "@/lib/aws/datasource-service";

export type NetworkObjectStatus = "in-use" | "orphan" | "pending-cleanup" | "needs-manual";

export interface DatasourceNetworkObject {
  kind: "security-group";
  sgId: string;
  groupName: string;
  region: string;
  targetId: string;
  vpcId?: string;
  /** 标签事实(2.1.2 及之前建的组没有;首次核对时补) */
  tagged: boolean;
  taggedDatasourceId?: string;
  /** 源行引用(事实);null = 没有任何源行引用它 */
  owner: { datasourceId: string; name: string; role: "primary" | "user-specified" | "legacy-platform" } | null;
  status: NetworkObjectStatus;
  /** 只对非在用的组查(在用的组查了也没意义) */
  eniCount?: number;
  cleanupJob?: { jobId: string; phase: string; createdAt: string; lastError?: string };
}

export interface DatasourceNetworkObjectsView {
  generatedAt: string;
  objects: DatasourceNetworkObject[];
  /** 读不到的区(限流 / 权限 / 该区 EC2 不可达)—— 如实列出,不当「这个区没有对象」 */
  unreadableRegions: Array<{ targetId: string; region: string; error: string }>;
}

export class NetworkObjectError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "NetworkObjectError";
  }
}

const MAX_PAGES = 200;

interface DsRef { datasourceId: string; name: string; role: DatasourceNetworkObject["owner"] extends infer O ? (O extends { role: infer R } ? R : never) : never }

/** 源行 → 它引用的全部安全组(主组 / 用户指定的全部 / 存量多建的平台组) */
export function securityGroupRefsOfRow(row: Record<string, unknown>): Array<{ sgId: string; role: "primary" | "user-specified" | "legacy-platform" }> {
  const nc = row.networkConfig as { securityGroupId?: unknown; securityGroupIds?: unknown; platformSecurityGroupId?: unknown } | undefined;
  if (!nc) return [];
  const out: Array<{ sgId: string; role: "primary" | "user-specified" | "legacy-platform" }> = [];
  if (typeof nc.securityGroupId === "string" && nc.securityGroupId) out.push({ sgId: nc.securityGroupId, role: "primary" });
  if (Array.isArray(nc.securityGroupIds)) for (const id of nc.securityGroupIds) if (typeof id === "string" && id && !out.some((x) => x.sgId === id)) out.push({ sgId: id, role: "user-specified" });
  if (typeof nc.platformSecurityGroupId === "string" && nc.platformSecurityGroupId && !out.some((x) => x.sgId === nc.platformSecurityGroupId)) out.push({ sgId: nc.platformSecurityGroupId, role: "legacy-platform" });
  return out;
}

async function scanDatasourceSgRefs(): Promise<Map<string, DsRef>> {
  const refs = new Map<string, DsRef>();
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await docClient.send(
      new ScanCommand({ TableName: TABLES.DATASOURCES, ProjectionExpression: "datasourceId, #n, networkConfig", ExpressionAttributeNames: { "#n": "name" }, ...(startKey ? { ExclusiveStartKey: startKey } : {}) })
    )) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const row of r.Items ?? []) {
      const id = typeof row.datasourceId === "string" ? row.datasourceId : "";
      if (!id) continue;
      for (const ref of securityGroupRefsOfRow(row)) {
        if (!refs.has(ref.sgId)) refs.set(ref.sgId, { datasourceId: id, name: typeof row.name === "string" && row.name ? row.name : id, role: ref.role });
      }
    }
    startKey = r.LastEvaluatedKey;
    if (!startKey) return refs;
  }
  throw new Error(`bgp-datasources 分页超过 ${MAX_PAGES} 页 —— 数据形态异常,拒绝给出可能不完整的归属清单`);
}

function isPlatformOwnedSg(fact: SecurityGroupFact): boolean {
  return fact.groupName.startsWith(PLATFORM_DS_SG_PREFIX) || fact.tags[PLATFORM_DS_MANAGED_TAG_KEY] === PLATFORM_DS_MANAGED_TAG_VALUE;
}

/** 全平台(注册表里每个有区的执行环境)的平台数据源安全组清单。读不到的区进 unreadableRegions。 */
export async function listDatasourceNetworkObjects(): Promise<DatasourceNetworkObjectsView> {
  const targets = (await listTargetsRaw()).filter((t) => typeof t.region === "string" && t.region);
  const refs = await scanDatasourceSgRefs();
  const objects: DatasourceNetworkObject[] = [];
  const unreadableRegions: DatasourceNetworkObjectsView["unreadableRegions"] = [];
  const seenRegion = new Set<string>();
  for (const t of targets) {
    if (seenRegion.has(t.region)) continue; // 一区一环境是不变量;真出现两条也只读一次
    seenRegion.add(t.region);
    let facts: Awaited<ReturnType<typeof listPlatformDsSecurityGroups>>;
    try {
      facts = await listPlatformDsSecurityGroups(t.region);
    } catch (e) {
      unreadableRegions.push({ targetId: t.targetId, region: t.region, error: String((e as Error)?.message ?? e).slice(0, 300) });
      continue;
    }
    const jobs = await listJobsByTarget(t.targetId, { kind: "sg-cleanup", maxItems: 500 }).catch(() => []);
    const jobBySg = new Map<string, DatasourceNetworkObject["cleanupJob"] & { terminal: boolean }>();
    for (const j of jobs) {
      const sgId = String((j.state as { sgId?: unknown })?.sgId ?? (j.evidence as { sgId?: unknown })?.sgId ?? "");
      if (!sgId) continue;
      const prev = jobBySg.get(sgId);
      if (!prev || prev.createdAt < j.createdAt) jobBySg.set(sgId, { jobId: j.jobId, phase: j.phase, createdAt: j.createdAt, lastError: j.lastError, terminal: isTerminalPhase(j.phase) });
    }
    for (const f of facts) {
      const owner = refs.get(f.groupId) ?? null;
      const job = jobBySg.get(f.groupId);
      let status: NetworkObjectStatus;
      if (owner) status = "in-use";
      else if (job && !job.terminal) status = "pending-cleanup";
      else if (job && job.phase === "failed") status = "needs-manual";
      else status = "orphan";
      const row: DatasourceNetworkObject = {
        kind: "security-group", sgId: f.groupId, groupName: f.groupName, region: t.region, targetId: t.targetId, vpcId: f.vpcId,
        tagged: f.tags[PLATFORM_DS_MANAGED_TAG_KEY] === PLATFORM_DS_MANAGED_TAG_VALUE,
        taggedDatasourceId: f.tags[PLATFORM_DS_OWNER_TAG_KEY] || undefined,
        owner, status,
        ...(job ? { cleanupJob: { jobId: job.jobId, phase: job.phase, createdAt: job.createdAt, ...(job.lastError ? { lastError: job.lastError } : {}) } } : {}),
      };
      if (status !== "in-use") {
        try { row.eniCount = await countNetworkInterfacesInSecurityGroup(f.groupId, t.region); } catch { /* 读不到就不填,页面显示「—」 */ }
      }
      objects.push(row);
    }
  }
  objects.sort((a, b) => (a.status === b.status ? a.groupName.localeCompare(b.groupName) : a.status === "in-use" ? 1 : b.status === "in-use" ? -1 : a.status.localeCompare(b.status)));
  return { generatedAt: new Date().toISOString(), objects, unreadableRegions };
}

/**
 * 请求清理一个孤儿平台组:服务端**重新**核三条件(是平台组 / 没有任何源行引用 / 网卡为 0),过了才入该缺陷的持久清理作业。
 * 🔴 不在这里 DeleteSecurityGroup:删除只由清理作业按网卡事实做(请求与删除之间网卡可能又挂上)。
 */
export async function requestOrphanSgCleanup(args: { sgId: string; region: string; targetId: string; createdBy: string }): Promise<{ jobId: string; created: boolean; phase: string; datasourceId: string }> {
  const { sgId, region, targetId } = args;
  if (!/^sg-[0-9a-f]{8,}$/.test(sgId) || !region || !targetId) throw new NetworkObjectError(400, "sgId / region / targetId 必填且 sgId 须形如 sg-…");
  const facts = await describeSecurityGroupsById([sgId], region);
  const fact = facts.get(sgId);
  if (!fact) throw new NetworkObjectError(404, `安全组 ${sgId} 在 ${region} 不存在(可能已被删除)`);
  if (!isPlatformOwnedSg(fact)) throw new NetworkObjectError(409, `安全组 ${sgId}(${fact.groupName})不是平台为数据源建的组(组名不以 ${PLATFORM_DS_SG_PREFIX} 开头且无 ${PLATFORM_DS_MANAGED_TAG_KEY} 标签)⇒ 平台不清理用户的组`);
  const refs = await scanDatasourceSgRefs();
  const owner = refs.get(sgId);
  if (owner) throw new NetworkObjectError(409, `安全组 ${sgId} 仍被数据源「${owner.name}」引用,不是孤儿 ⇒ 不清理(删它会让该源的同步失败,正是该缺陷的事故形态)`);
  const eniCount = await countNetworkInterfacesInSecurityGroup(sgId, region);
  if (eniCount > 0) throw new NetworkObjectError(409, `安全组 ${sgId} 仍被 ${eniCount} 张网卡引用 ⇒ 现在不能清理;等网卡释放后再试`);
  // 清理作业按「组名 == bgp-ds-<datasourceId 末 8 位>」判归属:有标签取标签里的源 id;存量无标签的组用组名后缀构造一个占位 id(末 8 位相同即可)
  const datasourceId = fact.tags[PLATFORM_DS_OWNER_TAG_KEY] || `orphan-${fact.groupName.slice(PLATFORM_DS_SG_PREFIX.length)}`;
  const r = await enqueueSgCleanup({ sgId, region, targetId, datasourceId, createdBy: args.createdBy });
  return { ...r, datasourceId };
}
