// 角色顾问入口 — 镜像 param-advisor 的分层:确定性引擎(policy-builder)秒回推荐,
// 供 UI 直接展示可复制策略 + 一键创建。IAM 策略是规则驱动,推荐值恒由确定性引擎给出(不用大模型编策略)。

import type { RoleEngine } from "./types";
import { adviseRole, type AdviseInput, type AdviseResult } from "./advise";

export type * from "./types";
export { normalizeRoleName, ROLE_NAME_PREFIX } from "./policy-builder";
export type { AdviseInput, AdviseResult } from "./advise";
export type { InferredNeed, ScanBinding } from "./script-scan";

export const ROLE_ENGINES: RoleEngine[] = ["glue", "emr", "dms", "flink"];

// 确定性推荐(零大模型)。
// 🔴🔴 2026-09-22:从同步的 `buildRoleAdvice` 换成 **`adviseRole`** ——
//   后者除了引擎必备基线,还做**代码解析 + 源头/目标绑定 + 配方库匹配**的权限推导
//   (用户原话:「目标/源头,都要扫描,自动生成所需要的权限,这里面涉及到代码解析,匹配配方库等操作。」)。
//   纯规则那层(`buildRoleAdvice`)刻意保留为同步纯函数供单测直接调,但**对外一律走这里**,
//   否则又是「机制早就建好,只是那条路径没接」。闭合判据钉在 `__tests__/role-advisor-wiring.test.ts`。
export async function recommendRole(req: AdviseInput): Promise<AdviseResult> {
  return adviseRole(req);
}
