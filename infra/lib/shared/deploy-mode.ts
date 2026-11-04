// @kf-batch 50-PROD-A-launch-hardening
/**
 * 部署模式的**唯一作者**:`production` | `demo`。
 *
 * 【为什么】原来 deploy-all 默认就把演示内容装进去:电商造数(SEED_DATA 缺省 1)、一台常驻计费的
 *   Multi-AZ 演示 MySQL(BgpRdsStack 无条件部署)、四个固定测试账号(pm-tester / rbac-tester /
 *   ops-analyst / biz-tester)。进客户生产账号,这些都是事故(测试账号能登录、假数据混进真目录)。
 *
 * 【规则】
 *   · 来源:CDK context `deploy-mode`,其次环境变量 `BGP_DEPLOY_MODE`(部署脚本导出,保证同一次部署里
 *     每一条 `cdk deploy` 看到同一个值;连带部署的依赖栈也一样)。
 *   · 🔴 **缺省 = production**:忘了传参的后果是「少装了演示的东西」,而不是「生产里冒出测试账号」。
 *     演示内容只在**显式** `demo` 时才装。客户入口 deploy-all 另外要求显式给出(见脚本)。
 *   · 非法值 ⇒ 抛(synth 当场失败),不猜。
 */
export type DeployMode = "production" | "demo";

export function resolveDeployMode(ctxValue: unknown, envValue: string | undefined = process.env.BGP_DEPLOY_MODE): DeployMode {
  const raw = (typeof ctxValue === "string" && ctxValue) || envValue || "";
  if (raw === "") return "production";
  if (raw === "production" || raw === "demo") return raw;
  throw new Error(`deploy-mode 非法:${JSON.stringify(raw)}(只允许 production / demo)`);
}

/** 初始用户名单:demo = 完整名单;production = 只留 admin(其余都是测试账号)。 */
export function rosterForMode<T>(fullRoster: Record<string, T>, mode: DeployMode): Record<string, T> {
  if (mode === "demo") return fullRoster;
  if (!("admin" in fullRoster)) throw new Error("初始用户名单里没有 admin");
  return { admin: fullRoster.admin };
}
