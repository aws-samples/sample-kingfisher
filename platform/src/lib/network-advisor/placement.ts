// 确定性候选放置选择器（无大模型）。据事实 + 约束挑选/排序 (VPC + 子网 + 计算 SG)。
//
// 两用途：① advise() 的兜底（大模型不可用/未选 placement 时，场景 D3）；② 校验大模型的选择。
// 排序启发式（移植自 discovery.md "Never auto-select" 之外的工程判断）：
//   含目标的 VPC > 有所需 endpoint > 私有子网 > 覆盖多 AZ > 非默认（专用）VPC。

import type { ConnectivityRequest, EnvironmentFacts, RecommendedPlacement, VpcFact } from "./types";

interface Candidate {
  placement: RecommendedPlacement;
  score: number;
  reason: string;
}

// 选计算侧安全组：优先复用 source.existingSecurityGroupIds；否则该 VPC 内名字像平台建的（bgp-）的；
// 再否则留空（交补救建议"建 SG"）。
function pickComputeSgs(vpc: VpcFact, req: ConnectivityRequest): { sgIds: string[]; reason: string } {
  const existing = req.source?.existingSecurityGroupIds || req.source?.securityGroupIds || [];
  const inVpc = existing.filter((id) => vpc.securityGroups.some((s) => s.groupId === id));
  if (inVpc.length) return { sgIds: inVpc, reason: "复用调用方已有的安全组" };

  const pinned = (req.constraints?.pinnedSecurityGroupIds || []).filter((id) => vpc.securityGroups.some((s) => s.groupId === id));
  if (pinned.length) return { sgIds: pinned, reason: "用户钉选的安全组" };

  const bgp = vpc.securityGroups.filter((s) => (s.name || "").startsWith("bgp-")).map((s) => s.groupId);
  if (bgp.length) return { sgIds: bgp.slice(0, 1), reason: "复用平台命名(bgp-)的安全组" };

  return { sgIds: [], reason: "该 VPC 暂无合适计算安全组，建议新建" };
}

// 选子网：preferPrivate 时优先私有；requireHA 时跨 ≥2 AZ；尽量覆盖目标 AZ。
function pickSubnets(vpc: VpcFact, req: ConnectivityRequest, targetAzs: Set<string>): { subnetIds: string[]; azs: string[]; reason: string } {
  const pinned = (req.constraints?.pinnedSubnetIds || []).filter((id) => vpc.subnets.some((s) => s.subnetId === id));
  if (pinned.length) {
    const azs = vpc.subnets.filter((s) => pinned.includes(s.subnetId)).map((s) => s.az);
    return { subnetIds: pinned, azs: Array.from(new Set(azs)), reason: "用户钉选的子网" };
  }

  const preferPrivate = req.constraints?.preferPrivate !== false; // 默认偏私有
  let pool = vpc.subnets.filter((s) => (preferPrivate ? !s.isPublic : true) && (s.freeIps == null || s.freeIps >= 2));
  if (pool.length === 0) pool = vpc.subnets; // 私有不够则放宽

  // 优先覆盖目标 AZ 的子网。
  const sorted = pool.slice().sort((a, b) => {
    const aHit = targetAzs.has(a.az) ? 1 : 0;
    const bHit = targetAzs.has(b.az) ? 1 : 0;
    if (aHit !== bHit) return bHit - aHit;
    return (b.freeIps ?? 0) - (a.freeIps ?? 0);
  });

  const wantHa = req.constraints?.requireHA || req.computeKind === "dms"; // DMS 复制子网组要 ≥2 AZ
  const picked: typeof sorted = [];
  const usedAz = new Set<string>();
  for (const s of sorted) {
    if (wantHa) {
      if (!usedAz.has(s.az)) { picked.push(s); usedAz.add(s.az); }
    } else {
      picked.push(s);
      break; // 单子网够（Glue/Flink 起步）
    }
    if (wantHa && picked.length >= 2) break;
  }
  if (picked.length === 0 && sorted.length) picked.push(sorted[0]);

  return {
    subnetIds: picked.map((s) => s.subnetId),
    azs: Array.from(new Set(picked.map((s) => s.az))),
    reason: `${preferPrivate ? "私有" : ""}子网${wantHa ? "（跨多 AZ 高可用）" : ""}`,
  };
}

export function selectCandidatePlacements(facts: EnvironmentFacts, req: ConnectivityRequest): Candidate[] {
  // 目标所在 VPC 与 AZ。
  const targetVpcIds = new Set(facts.targets.map((t) => t.vpcId).filter(Boolean) as string[]);
  const targetAzs = new Set(facts.targets.flatMap((t) => t.azs || []));

  const candidates: Candidate[] = [];
  for (const vpc of facts.vpcs) {
    const sub = pickSubnets(vpc, req, targetAzs);
    if (sub.subnetIds.length === 0) continue; // 无可用子网的 VPC 跳过
    const sg = pickComputeSgs(vpc, req);

    let score = 0;
    const reasons: string[] = [];
    if (targetVpcIds.has(vpc.vpcId)) { score += 50; reasons.push("与目标同 VPC"); }
    // 有任一 gateway/interface endpoint 视为更省成本可达。
    if (vpc.endpoints.length) { score += 15; reasons.push("含 VPC endpoint"); }
    if (vpc.subnets.some((s) => !s.isPublic)) { score += 10; reasons.push("有私有子网"); }
    if (sub.azs.length >= 2) { score += 8; reasons.push("覆盖多 AZ"); }
    if (!vpc.isDefault) { score += 5; reasons.push("专用 VPC"); }
    if (sg.sgIds.length) { score += 5; }

    candidates.push({
      placement: {
        vpcId: vpc.vpcId,
        subnetIds: sub.subnetIds,
        securityGroupIds: sg.sgIds,
        availabilityZones: sub.azs,
        rationale: [`${vpc.name || vpc.vpcId}`, sub.reason, sg.reason, ...reasons].filter(Boolean).join("；"),
      },
      score,
      reason: reasons.join("、") || "候选 VPC",
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}
