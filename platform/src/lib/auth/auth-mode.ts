// @kf-batch 50-PROD-A-launch-hardening
/**
 * 鉴权模式的**唯一判定**(中间件 / 身份解析 / JWT 校验三处共用;零依赖 ⇒ Edge 中间件可引)。
 *
 * 【为什么(生产上线批次 A,2026-10-09)】原来「没配 Cognito」= 全站放开 + 每个请求都是平台管理员:
 *   中间件 `if (!authConfigured()) return proceed`、`resolveIdentity` 回一个 isPlatformAdmin 的演示身份、
 *   `get-user` 缺 token 默认 `["bgp-admin"]`。客户环境只要漏注一个变量,就是匿名超级管理员,且没有任何告警。
 *   另外中间件与 verify-token 各读一份环境变量、回退顺序不同(后者多认 NEXT_PUBLIC_*)。
 *
 * 【现在】三态,**没有静默的第三条路**:
 *   · `cognito`      —— 用户池 + 应用客户端都配了 ⇒ 正常校验;
 *   · `disabled`     —— **显式** `BGP_AUTH_DISABLED=1`(仅本机开发 / 单测)⇒ 放开,身份 = 本地演示管理员;
 *   · `unconfigured` —— 两者都没有 ⇒ 中间件 503、身份解析 401。生产上这只可能是部署漏注,必须大声失败。
 * 环境变量在**调用时**读(不在模块加载时固化),单测才能切换。
 */
export type AuthMode = "cognito" | "disabled" | "unconfigured";

export function cognitoPoolId(): string {
  return process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "";
}
export function cognitoClientId(): string {
  return process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || process.env.COGNITO_CLIENT_ID || "";
}

export function authMode(): AuthMode {
  if (cognitoPoolId() && cognitoClientId()) return "cognito";
  if (process.env.BGP_AUTH_DISABLED === "1") return "disabled";
  return "unconfigured";
}

export const AUTH_UNCONFIGURED_MESSAGE =
  "平台鉴权未配置(缺 COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID),拒绝服务。" +
  "本机开发如需关闭鉴权,请显式设置 BGP_AUTH_DISABLED=1;生产环境出现本提示 = 部署漏注了 Cognito 配置。";
