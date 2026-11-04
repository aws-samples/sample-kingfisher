// **执行角色键**的唯一作者(50 SPEC v3.21 §3.1a「执行角色键」/ §6.1 段二落地口径)。
//
// 四个描述符键 ↔ 命名 SSOT 的四个 kind:
//   glueRoleArn → glueRole · emrExecutionRoleArn → emrServerlessRole · redshiftCopyRoleArn → redshiftCopyRole · dmsKinesisRoleArn → dmsKinesisRole
// (flinkRoleArn 早已 per-target,不在本文件的切换语义里。)
//
// 三条规则(与 SPEC §3.1a 那一行逐字同源):
//   ① **数据面解析**:非 home 的键缺失 **或** 角色名 ≠ 本 target 的 SSOT 名 ⇒ 抛(`assertPerTargetExecRole`)。
//      这是「共享角色只剩 home」在平台侧的结构保证 —— 与 synth-gate #6 反转互为镜像。
//   ② **补充部署窄通道的唯一例外**(`execRoleRotationVerdict`):执行角色键允许「新增」或「home 名 → 本 target 名」单向切换;
//      其它任何改写照旧拒。例外由 SSOT 判定,桶 / workgroup / 凭证一个字节都碰不到 —— 不是放宽「只增不改」。
//   ③ 存量描述符的 home 名 / 缺键**不在 §3.1a 判死**(否则重新部署前 tgt_usw2_a 当场不可用);由准入前置
//      `hasPerTargetExecRoles`(接进 `unusableReason`)与规则 ① 双门守。`missingPerTargetExecRoles` 就是那道前置的判据。
//
// 🔴 本文件**零 AWS SDK 依赖**(只有命名 SSOT + target-id):服务端 route / 客户端组件 / 单测都能 import。
import { resourceName } from "@/lib/aws/naming";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
// ARN 形态与角色名解析的唯一作者在 lib/execution-role/resolve.ts(此处原有一份同样的正则,已收口)
import { roleNameOfArn } from "@/lib/execution-role/resolve";

export const EXEC_ROLE_RESOURCE_KEYS = ["glueRoleArn", "emrExecutionRoleArn", "redshiftCopyRoleArn", "dmsKinesisRoleArn"] as const;
export type ExecRoleResourceKey = (typeof EXEC_ROLE_RESOURCE_KEYS)[number];

/** 键 → 命名 SSOT kind(`platform/naming.json`)。 */
export const EXEC_ROLE_KIND_BY_KEY: Record<ExecRoleResourceKey, string> = {
  glueRoleArn: "glueRole",
  emrExecutionRoleArn: "emrServerlessRole",
  redshiftCopyRoleArn: "redshiftCopyRole",
  dmsKinesisRoleArn: "dmsKinesisRole",
};

/** 键 → 它随哪个组件存在(`null` = core,恒需)。与 SPEC §1.1 资源袋一致。 */
export const EXEC_ROLE_COMPONENT_BY_KEY: Record<ExecRoleResourceKey, string | null> = {
  glueRoleArn: null,
  emrExecutionRoleArn: null,
  redshiftCopyRoleArn: "redshift",
  dmsKinesisRoleArn: "dms",
};

export function isExecRoleResourceKey(key: unknown): key is ExecRoleResourceKey {
  return typeof key === "string" && (EXEC_ROLE_RESOURCE_KEYS as readonly string[]).includes(key);
}

/** IAM 角色 ARN → 角色名(`role/<path?>/<name>` 取最后一段);不是字符串 / 不含 `:role/` ⇒ null。 */
export { roleNameOfArn };

/** 本 target 该键**应当**是哪个角色名(命名 SSOT;home ⇒ home 名)。 */
export function expectedExecRoleName(targetId: string, key: ExecRoleResourceKey): string {
  return resourceName(EXEC_ROLE_KIND_BY_KEY[key], { targetId });
}

/** 该 kind 的 home 角色名(切换的「前值」判据)。 */
export function homeExecRoleName(key: ExecRoleResourceKey): string {
  return resourceName(EXEC_ROLE_KIND_BY_KEY[key], { targetId: HOME_TARGET_ID });
}

export type ExecRoleVerdict =
  | { ok: true; arn: string }
  | { ok: false; reason: "missing" | "not-per-target"; message: string };

/**
 * 规则 ①:非 home 的执行角色键必须是本 target 自己的角色。home 恒 ok(home 走 env,本函数不管 home 的值)。
 * 拒因刻意**指路**:缺 / 不对的唯一修法是对该执行环境「重新部署」(升级),不是改描述符。
 */
export function execRoleVerdict(
  t: { targetId: string; resources?: Record<string, unknown> | null },
  key: ExecRoleResourceKey
): ExecRoleVerdict {
  const raw = (t.resources ?? {})[key];
  if (isHome(t.targetId)) {
    return typeof raw === "string" && raw ? { ok: true, arn: raw } : { ok: true, arn: "" };
  }
  const expected = expectedExecRoleName(t.targetId, key);
  const actual = roleNameOfArn(raw);
  if (actual === null) {
    return {
      ok: false,
      reason: "missing",
      message:
        `target ${t.targetId} 的描述符缺 resources.${key}(期望本 target 的角色 ${expected})—— ` +
        `SPEC §6.1 硬门:非 home 必须用绑死本 target 的执行角色;请对该执行环境执行一次「重新部署」以切换角色`,
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      reason: "not-per-target",
      message:
        `target ${t.targetId} 的 resources.${key} 不是本 target 的 per-target 角色(期望 ${expected},实为 ${actual})—— ` +
        `SPEC §6.1 硬门:共享角色只剩 home;请对该执行环境执行一次「重新部署」以切换角色`,
    };
  }
  return { ok: true, arn: raw as string };
}

/** 规则 ① 的抛错形态(数据面解析用)。返回 ARN。 */
export function assertPerTargetExecRole(
  t: { targetId: string; resources?: Record<string, unknown> | null },
  key: ExecRoleResourceKey
): string {
  const v = execRoleVerdict(t, key);
  if (!v.ok) throw new Error(v.message);
  return v.arn;
}

export type ExecRoleRotation = "add" | "rotate";

/**
 * 规则 ②:补充部署窄通道对执行角色键的**唯一**例外。
 * @returns `"add"`(前值不存在 ∧ 新值 = 本 target 名)/ `"rotate"`(前值 = 该 kind 的 home 名 ∧ 新值 = 本 target 名)/ `null`(拒)。
 * 🔴 home target 一律 `null`:home 的执行角色走 env、seed 不动,窄通道不该碰它的这些键。
 */
export function execRoleRotationVerdict(targetId: string, key: ExecRoleResourceKey, before: unknown, after: unknown): ExecRoleRotation | null {
  if (isHome(targetId)) return null;
  const afterName = roleNameOfArn(after);
  if (afterName === null || afterName !== expectedExecRoleName(targetId, key)) return null;
  if (before === undefined || before === null) return "add";
  const beforeName = roleNameOfArn(before);
  if (beforeName === homeExecRoleName(key)) return "rotate";
  return null;
}

/** 该 target 按其组件集**应有**的执行角色键(core 两键恒需;redshift / dms 随组件)。 */
export function requiredExecRoleKeys(components: readonly unknown[] | undefined | null): ExecRoleResourceKey[] {
  const comps = new Set((components ?? []).filter((c): c is string => typeof c === "string"));
  return EXEC_ROLE_RESOURCE_KEYS.filter((k) => {
    const comp = EXEC_ROLE_COMPONENT_BY_KEY[k];
    return comp === null || comps.has(comp);
  });
}

/**
 * 规则 ③ 的判据:非 home 缺哪些 per-target 执行角色(键缺 **或** 不是本 target 名都算缺)。home ⇒ 恒 []。
 * 把它接进 `residencyPrerequisite` / `unusableReason`;本包只提供判据(零生产调用方 ⇒ 按「未验证」对待,见单测)。
 */
export function missingPerTargetExecRoles(t: {
  targetId: string;
  components?: readonly unknown[] | null;
  resources?: Record<string, unknown> | null;
}): ExecRoleResourceKey[] {
  if (isHome(t.targetId)) return [];
  return requiredExecRoleKeys(t.components).filter((k) => !execRoleVerdict(t, k).ok);
}

export function hasPerTargetExecRoles(t: {
  targetId: string;
  components?: readonly unknown[] | null;
  resources?: Record<string, unknown> | null;
}): boolean {
  return missingPerTargetExecRoles(t).length === 0;
}
