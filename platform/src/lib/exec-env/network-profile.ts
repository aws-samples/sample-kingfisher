// (退役 K-5 网络规模)
// 🔴 **本模块只剩「兼容存量描述符」一个用途。**
//
// 【原来是什么】K-5:执行环境 base 栈用 NAT 出网,标准档 2 NAT = 2 EIP,而 EC2-VPC EIP 默认配额 5/区
//   ⇒ 每区最多 2 个执行环境。于是有了 standard / economy 两档 + 部署前 EIP 配额预检。
// 【为什么退役】用户 2026-09-06 拍板执行环境**零出网**(DESEIGN §18 决策 6octies):不建 NAT、不占 EIP,
//   全部 AWS 调用走 VPC 端点,唯一跨区路径是跨区 DynamoDB 接口端点 + 私有托管域(SPEC §3.16)。
//   ⇒ 「几个 NAT」这个问题**不存在了**,EIP 配额也不再是执行环境的约束。
// 【为什么不直接删掉字段】存量描述符里已经写着 `networkProfile: "standard" | "economy"`,
//   registry 的 zod schema 要继续认它(删了 = 存量 item 整包校验失败 = 平台读不出自己的注册表)。
//   ⇒ **保留值域与类型守卫,删掉一切「会导致行为」的东西**(NAT 映射 / 文案 / 缺省值):
//   留着映射表就等于留一个「可以再开 NAT」的口子,而那正是 change-safety A4 要消灭的。
//
// 相关退役件(同批一起删/改):`eip-preflight.ts`(删)· `GET /api/admin/exec-envs/preflight`(410)
//   · `POST /api/admin/exec-envs/[targetId]/network-profile`(410)· 向导 Step1 的网络规模单选与预检 Alert(删)
//   · broker 的 `EXEC_ENV_NAT_GATEWAYS` 注入与 buildspec / p0e-gate 的 `-c exec-env-nat-gateways`(删)
//   · `infra/lib/exec-env/context.ts` 的 `natGateways`(从类型里删除,传了就抛)。

/** 🔴 只为「读得懂存量描述符」而保留的值域。**不要**据此再派生任何行为。 */
export const NETWORK_PROFILES = ["standard", "economy"] as const;
export type NetworkProfile = (typeof NETWORK_PROFILES)[number];

export function isNetworkProfile(v: unknown): v is NetworkProfile {
  return typeof v === "string" && (NETWORK_PROFILES as readonly string[]).includes(v);
}
