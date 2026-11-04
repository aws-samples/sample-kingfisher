// @kf-batch 50-WP9a-durable-jobs
// permission canary 探针对象的**名字**(唯一作者;WORK-PACKAGES WP-9 ④-3)。
//
// 🔴 为什么单独一个零依赖文件:探针表由 admin 模板(`admin-ddl-templates.ts` 的 `create-canary-probes`)建,
//    由 canary 判据(`permission-canary.ts`)读 —— 两边必须是**同一个名字**。放进任何一边都会成环
//    (canary → 执行器 → 模板 → canary),所以名字住在两边都只是下游的这里。
import { projectSchema } from "@/lib/exec-env/project-schema";

/** 每个探针 schema 里的那张表名。 */
export const CANARY_TABLE = "bgp_canary";

/**
 * 🔴 「不授任何项目」的探针 schema:C-3 读它必须 `permission denied`。
 * 有了它,**只有一个项目**的环境也能做跨项目负测(不需要真有第二个项目)。
 */
export const CANARY_DENY_SCHEMA = "bgp_canary_deny";

/**
 * C-6 在 public 试建的表名(按项目区分,确定性)。
 * 🔴 确定性的理由:正常情况下这条 CREATE 必被拒,什么都不会留下;若某次真建成了(= 隔离有洞,C-6 判红),
 *    下一次再跑会撞「已存在」⇒ 判 unverifiable 并点名残留表,而不是每跑一次多一张垃圾表。
 */
export function canaryPublicProbeTable(projectId: string): string {
  return `${CANARY_TABLE}_c6_${projectSchema(projectId)}`;
}
