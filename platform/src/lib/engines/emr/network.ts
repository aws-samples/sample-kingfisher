// EMR 作业连接信息（VPC 网络接入）。
// 拍板③：凡有连接信息必须「创建任务时」就填清 + 网络顾问前置校验（别乱丢垃圾）。
// EMR Serverless application 的 networkConfiguration 需要 subnetIds + securityGroupIds
//（私有子网，对齐 memory network-private-only）。

import type { Prefill } from "@/lib/network-advisor/types";

export interface EmrNetwork {
  subnetIds: string[];
  securityGroupIds: string[];
  vpcId?: string; // 仅用于预填时同步选中 VPC 下拉;不参与持久化(job.network 只存 subnet/sg)。
}

export const EMR_NETWORK_EMPTY: EmrNetwork = { subnetIds: [], securityGroupIds: [] };

export function isEmrNetworkFilled(n?: EmrNetwork | null): boolean {
  return !!n && Array.isArray(n.subnetIds) && n.subnetIds.length > 0 && Array.isArray(n.securityGroupIds) && n.securityGroupIds.length > 0;
}

// 网络顾问 Prefill → EmrNetwork。EMR computeKind 走 generic 适配器
//（prefill-adapters.ts:toGeneric，返回 subnetIds/securityGroupIds/availabilityZones）。
export function emrNetworkFromPrefill(p: Prefill | undefined | null): EmrNetwork | null {
  if (!p) return null;
  if (p.channel === "generic") {
    return { subnetIds: p.subnetIds || [], securityGroupIds: p.securityGroupIds || [], vpcId: p.vpcId };
  }
  return null;
}
