// per-project 凭证 secret 的**查找**(50 SPEC §3.9 case "project-context" 第 3 行)。
//
// ── 为什么单独一个文件(不是塞进 privileged-cred 或 project-cred-supply)──────────
// 依赖方向:`privileged-cred`(判定)与 `project-cred-supply`(供给)**都**要用它,
// 而供给层要调闭合执行器、执行器又要调 `privileged-cred.requireCredentialIsolationState` ⇒
// 把查找放在任一侧都会形成三角环。放在最下游(只依赖 `target-clients` + `project-schema`)即无环。
//
// 🔴 **本文件替换掉的是一个 `return undefined` 的 stub**。那个 stub 在 G 阶段是对的
// (per-project secret 还不存在,返回假 ARN 会把 execute/genbi/data-service 提前打挂),
// 但它同时也是**整条隔离链的短路点**:只要它恒为 undefined,`isolated` 状态下每一次
// project-context 都必然走到 "no per-project credential — refuse"。

import type { ExecutionTarget } from "@/lib/exec-env/registry";
import { assertProjectId, projectSecretName } from "@/lib/exec-env/project-schema";
import { deleteSecretByName, describeSecretArnByName, resolveTargetWarehouse } from "@/lib/exec-env/target-clients";

/**
 * 查某个项目在某个 target 上的 per-project 凭证 ARN。
 *
 * @returns ARN,或 `undefined` = **确认不存在**(`ResourceNotFoundException`)。
 *
 * 🔴🔴 **读失败一律抛,绝不返回 undefined**。这是本文件最重要的一行语义:
 * 调用方 `getPrivilegedCred` 把 `undefined` 解释成"没有 per-project 凭证" ⇒
 * 在 `legacy-seeded` / `provisioning` 窗口内它会**回落共享 admin**。
 * 于是"读失败 == 没有凭证"这个等式意味着:**一次 throttling / AccessDenied / 网络抖动
 * 就能把已经供给好的项目降级回 admin**,而且不留任何异常痕迹。
 * §3.9b 的方向是「查不到 ≠ 没问题」—— 在这里就是「读不到 ≠ 没有」。
 */
export async function lookupProjectSecretArn(t: ExecutionTarget, projectId: string): Promise<string | undefined> {
  const pid = assertProjectId(projectId);
  const name = projectSecretName(t.targetId, pid);
  // region 必须是**该 target 的** region:secret 与 target 同区(把写语句翻成 execution 轴
  // 就是为了这件事)。用 `process.env.AWS_REGION` 查非 home 的 secret 会稳定查不到 ⇒
  // 被上面那条语义解释成"没有凭证" ⇒ 静默回落 admin。
  const { region } = resolveTargetWarehouse(t);
  return describeSecretArnByName(region, name);
}

/**
 * 删掉某个项目在某个 target 上的 per-project 凭证 secret(删项目后的**回收**作业用)。
 *
 * 🔴 名字与 region 的派生和 `lookupProjectSecretArn` **逐字同一份**(同一个文件、同两行):
 *    名字只经 `projectSecretName`,region 只经 `resolveTargetWarehouse(t)` —— 查与删若各派生一遍,
 *    任何一边漂了都会变成「回收报成功、真 secret 原封不动」(删的是另一个名字 / 另一个区,回 absent)。
 */
export async function deleteProjectSecret(
  t: ExecutionTarget,
  projectId: string
): Promise<{ secretName: string; region: string; outcome: "deleted" | "absent" }> {
  const pid = assertProjectId(projectId);
  const name = projectSecretName(t.targetId, pid);
  const { region } = resolveTargetWarehouse(t);
  return { secretName: name, region, outcome: await deleteSecretByName(region, name) };
}
