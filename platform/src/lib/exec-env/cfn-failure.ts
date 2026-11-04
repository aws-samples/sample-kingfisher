// CFN 失败原因 → 人话(失败收敛器 / 详情页共用;只翻译**已知**形态,其余原样返回)。
//
// 【为什么单独一个文件】这个翻译器原来住在 `eip-preflight.ts` 里(K-5 那批一起写的),而把
//   EIP 预检整块下线了 —— 但翻译器本身**不是 EIP 专用**:它是「把 CloudFormation 的英文原因变成
//   运维读得懂的一句话 + 怎么修」这一类的落点,后面还会长。搬出来,免得跟着退役件一起被删掉。
// 🔴 保留 EIP 那一条:**存量环境可能还带着 NAT**(切换要一个个 target 走升级动线),
//   切换完成前仍可能撞到 EIP 配额;而且历史失败原因还留在台账里要能翻译。

/** EC2-VPC Elastic IPs 配额码(Service Quotas,service ec2)。 */
export const EIP_QUOTA_CODE = "L-0263D0A3";

export function explainCfnFailure(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  if (/maximum number of addresses has been reached/i.test(reason)) {
    return (
      `EIP 配额不足(EC2-VPC Elastic IPs,配额码 ${EIP_QUOTA_CODE})。` +
      `执行环境**零出网、不占 EIP**;还会撞到这条,说明该 target 仍是切换前的带 NAT 底座 ` +
      `⇒ 走一次「重新部署」(预演 → 审批 → 部署)把它切到零出网即可,或先提额。原文:${reason}`
    );
  }
  // 跨区端点缺授权 —— 部署会走到建端点那一步才炸,报文很难懂
  if (/vpce:AllowMultiRegion/i.test(reason)) {
    return (
      `缺少跨区 VPC 端点授权 \`vpce:AllowMultiRegion\`。这个动作**不被通配符策略匹配**` +
      `(Administrator / PowerUser 都不行),必须逐字授予部署角色 —— 由控制面平台栈附加到 ` +
      `cdk-hnb659fds-cfn-exec-role-<账号>-<region>(SPEC §3.16-D)。先重部署一次控制面平台栈,再重试。原文:${reason}`
    );
  }
  return reason;
}
