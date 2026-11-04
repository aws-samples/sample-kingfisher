// @kf-batch 50-PROD-A-launch-hardening(h)
// 「这次 synth 出来的控制面栈,真的落在部署脚本要的那个主控区吗」的单一判定。
//
// 🔴 2026-10-10 第二账号 production 彩排(主控区 us-west-2)实撞:部署机 shell 里有 `AWS_REGION=us-east-1`,
//   CDK CLI 解析目标区时 AWS_REGION 优先于部署脚本导出的 CDK_DEFAULT_REGION(CLI 会覆盖它)
//   ⇒ 命令写的是 us-west-2,11 个控制面栈**全部建进了 us-east-1**,一路绿灯。
//   测试账号主控区恰好是 us-east-1(与那个环境变量重合)⇒ 从来看不见。
// 做法:部署脚本导出 KF_HOME_REGION=<它要的主控区>;app.ts 在实例化任何栈之前比对 CDK 最终解析出来的区,
//   不一致 ⇒ synth 当场失败(一个栈都不部署)。没导出 KF_HOME_REGION(裸 cdk / 执行环境栈组)⇒ 不判。
export function homeRegionMismatch(resolved: string | undefined, expected: string | undefined): string | null {
  if (!expected) return null;
  if (resolved === expected) return null;
  return (
    `CDK 解析出的目标区 = ${resolved ?? "(未解析)"},而部署脚本要的主控区 = ${expected} ⇒ 拒绝 synth(否则整套控制面会建进错的区)。` +
    `常见原因:部署机环境里的 AWS_REGION / AWS_DEFAULT_REGION 或 profile 的默认区与主控区不一致 —— ` +
    `经 scripts/deploy-all.sh / redeploy-platform.sh 部署(它们会对齐这两个变量),或手动 export AWS_REGION=${expected}。`
  );
}
