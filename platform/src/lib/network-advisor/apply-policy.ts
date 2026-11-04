// 一键修复白名单(纯策略,无 AWS SDK 依赖)——供 remediation.ts(可能被前端间接引用)与 apply.ts 共用,
// 避免 remediation 侧因引入执行器(带 @aws-sdk/client-ec2)而把 SDK 打进客户端 bundle。
import type { RemediationType } from "./types";

// 可一键执行的 remediation(低风险 + 可逆 + 只创建不删改 + 参数服务端可完全重解析)。
export const AUTO_APPLICABLE: RemediationType[] = ["enable-dns-attributes", "create-s3-gateway-endpoint"];

export function isAutoApplicable(type: RemediationType): boolean {
  return AUTO_APPLICABLE.includes(type);
}
