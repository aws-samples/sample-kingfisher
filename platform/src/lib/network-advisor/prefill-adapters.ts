// 把通道无关的 RecommendedPlacement 映射成各消费方原生的网络配置形态。
// 字段名对齐真实服务/本仓现有代码：
//  - Glue: PhysicalConnectionRequirements{SubnetId, SecurityGroupIdList, AvailabilityZone}（datasource-service.createGlueConnection）
//  - Flink MSAF: VpcConfiguration{SubnetIds[], SecurityGroupIds[]}（flink-service.resolveSinkVpc/resolveCustomVpc）
//  - DMS: 复制子网组（≥2 AZ 子网）+ VPC SGs
//  - Zero-ETL: 托管网络，建议性 note（真正杠杆是 RDS binlog + namespace resource policy）

import type { ComputeKind, Prefill, RecommendedPlacement } from "./types";

export function toGlue(p: RecommendedPlacement): Extract<Prefill, { channel: "glue" }> {
  // Glue 单子网；AZ 必须等于该子网 AZ（否则运行时失败，见 rules AZ_MATCH）。
  return {
    channel: "glue",
    subnetId: p.subnetIds[0] || "",
    securityGroupIdList: p.securityGroupIds,
    availabilityZone: p.availabilityZones[0] || "",
  };
}

export function toFlink(p: RecommendedPlacement): Extract<Prefill, { channel: "flink" }> {
  return { channel: "flink", vpcConfiguration: { SubnetIds: p.subnetIds, SecurityGroupIds: p.securityGroupIds } };
}

export function toDms(p: RecommendedPlacement): Extract<Prefill, { channel: "dms" }> {
  return { channel: "dms", replicationSubnetGroupSubnetIds: p.subnetIds, vpcSecurityGroupIds: p.securityGroupIds };
}

export function toZeroEtl(_p: RecommendedPlacement): Extract<Prefill, { channel: "zeroetl" }> {
  return {
    channel: "zeroetl",
    note: "Zero-ETL 使用 AWS 托管网络，无需选择子网/SG；请确保源 RDS 开启 ROW 格式 binlog，且目标 Redshift namespace 的资源策略已授权源 ARN。",
  };
}

export function toLambdaVpc(p: RecommendedPlacement): Extract<Prefill, { channel: "lambda-vpc" }> {
  return { channel: "lambda-vpc", subnetIds: p.subnetIds, securityGroupIds: p.securityGroupIds };
}

export function toGeneric(p: RecommendedPlacement): Extract<Prefill, { channel: "generic" }> {
  // vpcId 一并回传:EMR 等 generic 消费方的「连接信息」有独立 VPC 下拉,预填时需要它才能同时选中 VPC。
  return { channel: "generic", vpcId: p.vpcId, subnetIds: p.subnetIds, securityGroupIds: p.securityGroupIds, availabilityZones: p.availabilityZones };
}

// 分发：据 computeKind 选适配器。
export function prefillFor(kind: ComputeKind, p: RecommendedPlacement): Prefill {
  switch (kind) {
    case "glue": return toGlue(p);
    case "flink": return toFlink(p);
    case "dms": return toDms(p);
    case "zeroetl": return toZeroEtl(p);
    case "lambda-vpc": return toLambdaVpc(p);
    case "emr":
    case "generic":
    default:
      return toGeneric(p);
  }
}
