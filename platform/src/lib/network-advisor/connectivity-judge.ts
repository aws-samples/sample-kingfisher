// L2 连通性裁决层（确定性，权威）。纯函数：在 EnvironmentFacts + 候选放置(placement) 上执行
// rules.ts 的规则 → Ruling[]，再折叠成 Verdict。无大模型、无副作用、可单测。
//
// 关键纪律：缺所需事实 → 返回 UNKNOWN，绝不静默 PASS（场景 D1）。这样降级时 verdict 诚实封顶
// 为 UNK，而非谎报 reachable。

import { RULE_BY_ID, ruleApplies } from "./rules";
import type {
  ComputeKind,
  EnvironmentFacts,
  RecommendedPlacement,
  ResolvedTarget,
  Ruling,
  SecurityGroupFact,
  VpcFact,
  Verdict,
  Constraints,
} from "./types";

function mk(ruleId: string, status: Ruling["status"], detail: string, forTargetIndex?: number): Ruling {
  const r = RULE_BY_ID[ruleId];
  return { ruleId, title: r?.title || ruleId, status, detail, forTargetIndex, remediationType: r?.remediationType };
}

// 某 SG 是否有自引用 all-traffic 入站规则。
function hasSelfRef(sg: SecurityGroupFact): boolean {
  return sg.ingress.some((r) => r.sgRefs.includes(sg.groupId) && (r.protocol === "-1" || r.protocol === "all"));
}

// 端口是否落在规则范围内。
function portInRule(port: number, fromPort?: number, toPort?: number, protocol?: string): boolean {
  if (protocol === "-1" || protocol === "all") return true;
  if (fromPort == null || toPort == null) return false;
  return port >= fromPort && port <= toPort;
}

// 目标 SG 是否放行来自任一计算 SG-ID 的目标端口入站。
function targetAllowsIngressFromSg(targetSg: SecurityGroupFact, computeSgIds: string[], port: number): boolean {
  return targetSg.ingress.some((r) => r.sgRefs.some((ref) => computeSgIds.includes(ref)) && portInRule(port, r.fromPort, r.toPort, r.protocol));
}
// 目标 SG 是否仅靠 CIDR 放行该端口（连通但非最小权限）。
function targetAllowsIngressByCidr(targetSg: SecurityGroupFact, port: number): boolean {
  return targetSg.ingress.some((r) => r.cidrs.length > 0 && portInRule(port, r.fromPort, r.toPort, r.protocol));
}

// 计算 SG 是否出站放行目标端口（默认 SG 出站全开 → 无显式 egress 视为全开）。
function egressAllows(sg: SecurityGroupFact, port: number): boolean {
  if (sg.egress.length === 0) return true; // AWS 默认出站全放行
  return sg.egress.some((r) => portInRule(port, r.fromPort, r.toPort, r.protocol) || r.protocol === "-1");
}

// VPC 内某 service 是否有可用 endpoint。
function findEndpoint(vpc: VpcFact, serviceSuffix: string, type: "Gateway" | "Interface") {
  return vpc.endpoints.find((e) => e.type === type && e.service.endsWith(`.${serviceSuffix}`));
}

// 子网经 NACL 是否放行目标端口（简化：找显式 deny 命中则 FAIL，否则按 allow 默认）。
function naclBlocks(vpc: VpcFact, subnetId: string, port: number): boolean | null {
  const nacl = vpc.nacls.find((n) => n.subnetIds.includes(subnetId));
  if (!nacl) return null; // 未知
  // 按 ruleNumber 升序，第一条命中端口的 egress allow/deny 决定。
  const egress = nacl.entries.filter((e) => e.egress).sort((a, b) => a.ruleNumber - b.ruleNumber);
  for (const e of egress) {
    const hit = e.protocol === "-1" || portInRule(port, e.fromPort, e.toPort, e.protocol);
    if (hit) return e.ruleAction === "deny";
  }
  return false;
}

export interface JudgeInput {
  facts: EnvironmentFacts;
  computeKind: ComputeKind;
  placement: RecommendedPlacement; // 待裁决的候选放置
  constraints?: Constraints;
}

// 对单个目标在给定放置下逐规则裁决。
function judgeTarget(input: JudgeInput, target: ResolvedTarget, idx: number): Ruling[] {
  const { facts, computeKind, placement, constraints } = input;
  const rulings: Ruling[] = [];
  const vpc = facts.vpcs.find((v) => v.vpcId === placement.vpcId);
  const computeSgs = (vpc?.securityGroups || []).filter((s) => placement.securityGroupIds.includes(s.groupId));
  const subnets = (vpc?.subnets || []).filter((s) => placement.subnetIds.includes(s.subnetId));
  const ap = (id: string) => ruleApplies(RULE_BY_ID[id], computeKind);

  // DISCOVERABILITY：目标不可解析 → 直接 needs-input。
  if (!target.discoverable && (target.endpointModel === "unknown" || target.endpointModel === "cross-account")) {
    rulings.push(mk("DISCOVERABILITY", "FAIL", `目标不可自动发现（${target.notes?.join("；") || target.target.kind}），需用户提供 VPC/CIDR/SG。`, idx));
    return rulings; // 不可发现时其它规则无意义
  }

  // 托管型目标（Redshift Serverless / Zero-ETL 托管网络）——无 ENI 放置裁决。
  if (target.endpointModel === "managed-vpc") {
    rulings.push(mk("ROUTE", "PASS", "目标为 AWS 托管网络（如 Redshift Serverless），经托管通道访问，无需选择子网/SG。", idx));
    return rulings;
  }
  if (target.endpointModel === "managed-public") {
    rulings.push(mk("ROUTE", "PASS", "目标为公网可达的托管端点。", idx));
    if (constraints?.preferPrivate) rulings.push(mk("LEAST_PRIV", "FAIL", "目标走公网，但用户要求优先私有路径；建议改私有子网 + endpoint/peering。", idx));
    return rulings;
  }
  if (target.endpointModel === "cross-region") {
    rulings.push(mk("CROSS_REGION", "FAIL", "目标在另一 region，无同 VPC 路径，需跨 region peering/TGW 或公网+TLS。", idx));
    return rulings;
  }
  if (target.endpointModel === "internet") {
    // 外部 SaaS：需出网。
    const subnetsForEgress = subnets.length ? subnets : (vpc?.subnets || []).filter((s) => placement.subnetIds.includes(s.subnetId));
    const anyNat = subnetsForEgress.some((s) => s.routesToNat);
    rulings.push(mk("PRIVATE_EGRESS", anyNat ? "PASS" : "FAIL", anyNat ? "私有子网经 NAT 可出网访问外部 SaaS。" : "外部 SaaS 需出网；当前私有子网无 NAT，需加 NAT 或 PrivateLink。", idx));
    return rulings;
  }

  // AWS 服务目标（S3/Secrets/Kinesis…）——endpoint / NAT 判定。
  if (target.target.kind === "aws-service") {
    const svc = target.target.service;
    const subnetsForSvc = (vpc?.subnets || []).filter((s) => placement.subnetIds.includes(s.subnetId));
    const anyNat = subnetsForSvc.some((s) => s.routesToNat);
    if (target.endpointModel === "needs-gateway-endpoint") {
      const ep = vpc ? findEndpoint(vpc, svc === "dynamodb" ? "dynamodb" : "s3", "Gateway") : undefined;
      if (ep) {
        rulings.push(mk("GATEWAY_ENDPOINT", "PASS", `存在 ${svc} gateway endpoint（${ep.id}）。`, idx));
        if (ep.policyRestrictive) rulings.push(mk("ENDPOINT_POLICY", "UNKNOWN", "endpoint 配了自定义策略，需确认放行目标资源 ARN。", idx));
      } else if (anyNat) {
        rulings.push(mk("PRIVATE_EGRESS", "PASS", `无 ${svc} gateway endpoint，但子网经 NAT 可出网（建议加 gateway endpoint 省成本）。`, idx));
      } else {
        rulings.push(mk("GATEWAY_ENDPOINT", "FAIL", `私有子网无 NAT 且无 ${svc} gateway endpoint → 会报 UnableToFindVpcEndpoint。建议建 gateway endpoint（免费）。`, idx));
      }
    } else {
      // interface endpoint。
      const ep = vpc ? vpc.endpoints.find((e) => e.type === "Interface" && e.service.includes(svc)) : undefined;
      if (ep) {
        rulings.push(mk("INTERFACE_ENDPOINT", "PASS", `存在 ${svc} interface endpoint（${ep.id}）。`, idx));
        if (vpc && (!vpc.dnsSupport || !vpc.dnsHostnames) && ep.privateDnsEnabled) rulings.push(mk("DNS_ATTRS", "FAIL", "endpoint 启用了私有 DNS，但 VPC 未同时开启 enableDnsSupport/enableDnsHostnames。", idx));
      } else if (anyNat) {
        rulings.push(mk("PRIVATE_EGRESS", "PASS", `无 ${svc} interface endpoint，但子网经 NAT 可出网（私有访问建议加 interface endpoint）。`, idx));
      } else {
        rulings.push(mk("INTERFACE_ENDPOINT", "FAIL", `私有子网无 NAT 且无 ${svc} interface endpoint → 无法访问该服务。建议建 interface endpoint（SG 放行 :443，开启私有 DNS）。`, idx));
      }
    }
    return rulings;
  }

  // ── in-vpc 目标（RDS/Aurora/Redshift provisioned/自建 in-VPC）：完整裁决 ──

  // ROUTE：同 VPC=local；跨 VPC 查 peering/TGW。
  if (!vpc) {
    rulings.push(mk("ROUTE", "UNKNOWN", `候选放置的 VPC ${placement.vpcId} 未探测到（可能 IAM 受限或不存在）。`, idx));
  } else if (target.vpcId && target.vpcId === vpc.vpcId) {
    rulings.push(mk("ROUTE", "PASS", "计算与目标在同一 VPC，local 路由自动可达。", idx));
  } else if (target.vpcId) {
    const peer = vpc.peerings.find((p) => p.peerVpcId === target.vpcId);
    const hasTgw = vpc.tgwAttachments.length > 0;
    if (peer) rulings.push(mk("ROUTE", "UNKNOWN", `存在到目标 VPC 的 peering（${peer.peeringId}），但需确认双方路由表都加了对端 CIDR 路由。`, idx));
    else if (hasTgw) rulings.push(mk("ROUTE", "UNKNOWN", "存在 TGW 附着，但跨 TGW 路由需确认两侧路由表（Phase 1 不深探 TGW 路由）。", idx));
    else rulings.push(mk("ROUTE", "FAIL", "计算与目标不在同一 VPC，且未发现 peering/TGW 路径，需建立跨 VPC 路由。", idx));
  } else {
    rulings.push(mk("ROUTE", "UNKNOWN", "目标 VPC 未知，无法确认路由。", idx));
  }

  // 计算 SG 相关（自引用 / 出站 / 目标入站）。
  if (computeSgs.length === 0) {
    rulings.push(mk("SOURCE_INGRESS_FROM_SG", "UNKNOWN", "尚未选定计算安全组，无法判定目标入站；建议先建/选计算 SG。", idx));
  } else {
    // SELF_REF（仅对需要 ENI 互通的计算）。
    if (ap("SELF_REF")) {
      const ok = computeSgs.some((sg) => hasSelfRef(sg));
      rulings.push(mk("SELF_REF", ok ? "PASS" : "FAIL", ok ? "计算 SG 含自引用规则。" : "计算 SG 缺自引用（all-traffic, source=自身）入站规则，ENI 间无法通信。", idx));
    }
    // EGRESS_TO_TARGET。
    const egOk = computeSgs.some((sg) => egressAllows(sg, target.port));
    rulings.push(mk("EGRESS_TO_TARGET", egOk ? "PASS" : "FAIL", egOk ? "计算 SG 出站放行目标端口。" : `计算 SG 出站未放行目标端口 ${target.port}。`, idx));

    // SOURCE_INGRESS_FROM_SG。
    const computeSgIds = computeSgs.map((s) => s.groupId);
    const targetSgs = (vpc?.securityGroups || []).filter((s) => target.securityGroupIds.includes(s.groupId));
    if (targetSgs.length === 0) {
      rulings.push(mk("SOURCE_INGRESS_FROM_SG", "UNKNOWN", "目标安全组未探测到（可能跨 VPC/IAM 受限），无法确认入站放行。", idx));
    } else {
      const bySg = targetSgs.some((sg) => targetAllowsIngressFromSg(sg, computeSgIds, target.port));
      const byCidr = targetSgs.some((sg) => targetAllowsIngressByCidr(sg, target.port));
      if (bySg) {
        rulings.push(mk("SOURCE_INGRESS_FROM_SG", "PASS", "目标 SG 已放行来自计算 SG-ID 的目标端口入站。", idx));
      } else if (byCidr) {
        rulings.push(mk("SOURCE_INGRESS_FROM_SG", "PASS", "目标 SG 经 CIDR 放行了目标端口（连通可行）。", idx));
        if (constraints?.leastPrivilege) rulings.push(mk("LEAST_PRIV", "FAIL", "目标入站用 CIDR 放行；最小权限建议改为引用计算 SG-ID（ENI IP 会变）。", idx));
      } else {
        rulings.push(mk("SOURCE_INGRESS_FROM_SG", "FAIL", `目标 SG 未放行目标端口 ${target.port} 来自计算 SG，需加入站规则（引用计算 SG-ID）。`, idx));
      }
    }
  }

  // NACL（每个候选子网）。
  if (vpc) {
    for (const sId of placement.subnetIds) {
      const blocked = naclBlocks(vpc, sId, target.port);
      if (blocked === true) { rulings.push(mk("NACL", "FAIL", `子网 ${sId} 的 NACL 拒绝目标端口 ${target.port}。`, idx)); break; }
    }
  }

  // IP_CAPACITY。
  const lowIp = subnets.find((s) => s.freeIps != null && s.freeIps < 2);
  if (lowIp) rulings.push(mk("IP_CAPACITY", "FAIL", `子网 ${lowIp.subnetId} 空闲 IP 不足（${lowIp.freeIps}），ENI 可能无法分配。`, idx));

  // AZ_MATCH（仅 Glue）。
  if (ap("AZ_MATCH") && computeKind === "glue" && subnets.length && target.azs?.length) {
    const subnetAz = subnets[0].az;
    const placementAz = placement.availabilityZones[0];
    if (placementAz && placementAz !== subnetAz) {
      rulings.push(mk("AZ_MATCH", "FAIL", `Glue 连接 AZ(${placementAz}) 与子网 AZ(${subnetAz}) 不一致，将在作业运行时失败。`, idx));
    } else {
      rulings.push(mk("AZ_MATCH", "PASS", "Glue 连接 AZ 与子网 AZ 一致。", idx));
    }
  }

  // AZ_COVERAGE（HA）。
  if (input.constraints?.requireHA && placement.availabilityZones.length < 2) {
    rulings.push(mk("AZ_COVERAGE", "FAIL", "要求高可用但放置未覆盖 ≥2 个 AZ。", idx));
  }

  return rulings;
}

// 把多目标多规则的 Ruling 折叠成最终 Verdict（取最差）。
export function foldVerdict(rulings: Ruling[]): Verdict {
  const hard = rulings.filter((r) => RULE_BY_ID[r.ruleId]?.severity === "hard");
  if (hard.some((r) => r.ruleId === "DISCOVERABILITY" && r.status === "FAIL")) return "needs-input";
  if (hard.some((r) => r.status === "FAIL")) {
    // 跨 region 等无补救 → unreachable；其余 hard FAIL 一般可补救 → reachable-after-fixes。
    const unrec = hard.some((r) => (r.ruleId === "CROSS_REGION") && r.status === "FAIL");
    return unrec ? "unreachable" : "reachable-after-fixes";
  }
  if (hard.some((r) => r.status === "UNKNOWN")) return "unknown";
  if (hard.length === 0) return "unknown"; // 没有任何 hard 规则被评估 → 不确定
  return "reachable";
}

// 公开：对一个候选放置裁决所有目标。
export function adjudicate(input: JudgeInput): { rulings: Ruling[]; verdict: Verdict } {
  const all: Ruling[] = [];
  input.facts.targets.forEach((t, i) => {
    all.push(...judgeTarget(input, t, i));
  });
  return { rulings: all, verdict: foldVerdict(all) };
}
