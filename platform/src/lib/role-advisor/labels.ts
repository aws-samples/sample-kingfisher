// 角色顾问的**界面口径单一作者**(客户端安全:不引任何 AWS SDK)。
//
// 🔴🔴 2026-10-01 新账号无头复现(页面半边):
//   ① 预检拒因叫用户去「角色顾问」点**一键补齐**,而页面上那个按钮叫「一键创建角色」——
//     **两个作者各写一个名字** ⇒ 拒因指向一个不存在的按钮;
//   ② 后端对已存在的角色**真的对账补回了**缺的权限(IAM 实读坐实),页面却只说「角色已存在,已复用」——
//     `reconciledSids` 一路返回到前端,在最后一跳被丢掉了(「写了 ≠ 接上了」)。
// ⇒ 按钮文案与「点哪里」的指引只在这里写一次;「一键」的结果收成封闭的三态,界面逐态呈现。

/** 先点它出推荐,「一键」按钮才会出现。 */
export const ROLE_RECOMMEND_BUTTON_LABEL = "推荐执行角色权限";
/** 同一个按钮:角色不存在 ⇒ 创建;已存在 ⇒ 按必备权限清单对账补齐。 */
export const ROLE_APPLY_BUTTON_LABEL = "一键创建 / 补齐角色";
/** 拒因 / 提示里「出路」那一句的唯一写法。 */
export const ROLE_APPLY_HOW_TO =
  `到作业表单里的「角色顾问」先点「${ROLE_RECOMMEND_BUTTON_LABEL}」,再点「${ROLE_APPLY_BUTTON_LABEL}」(需平台管理员)`;

export interface ProvisionResultLike {
  roleName: string;
  created: boolean;
  reconciled?: boolean;
  reconciledSids?: string[];
}

/** 「一键」的结果:封闭三态,界面必须逐态说清(不许把「补过了」说成「复用」)。 */
export type ProvisionOutcome =
  | { kind: "created"; roleName: string }
  | { kind: "reconciled"; roleName: string; sids: string[] }
  | { kind: "unchanged"; roleName: string };

export function provisionOutcome(r: ProvisionResultLike): ProvisionOutcome {
  if (r.created) return { kind: "created", roleName: r.roleName };
  const sids = (r.reconciledSids || []).filter(Boolean);
  // 🔴 以「补了哪几条」为准,不以 `reconciled` 布尔为准:两者不一致时宁可如实列出补了什么
  if (sids.length || r.reconciled) return { kind: "reconciled", roleName: r.roleName, sids };
  return { kind: "unchanged", roleName: r.roleName };
}
