// @kf-batch 50-W5-seg1-WP10a
// Glue 作业名的**唯一作者**(per-target)。
//
// 【为什么要有这个文件(2026-09-05 真环境 E-142 抓到的隔离洞)】原来作业名 = `bgp-etl-<jobId 尾 12 位>`,并刻意「跨区同名」:
//   Glue 作业是 region 作用域,不同 region 同名不冲突 ⇒ home 存量不变、DAG 不必按区改名、作业行只存一个名字。
//   这个前提在**同一 region 有两个 target**(tgt_usw2_a / tgt_usw2_b)时就破了:扇出逐 target `ensureGlueJob`
//   对**同一个** Glue 作业名 Create/Update,后写的 target 把前一个 target 的 Role / 脚本桶 / `--bgp_*` 参数**整个盖掉**
//   ⇒ tgt_usw2_a 的 run 实际用 tgt_usw2_b 的执行角色跑(w3i E-142 当场红)。这是跨 target 的 IAM / 数据面边界被静默打穿,
//   与 SPEC §6.1「资源面限本 target」直接冲突。
//
// 【修法】非 home 的作业名带 target slug:`bgp-etl-<id12>-<slug>`;home 保持 `bgp-etl-<id12>`(存量逐字节不变)。
//   名字**只在这里派生**:job-service(建/跑)、dag-generator(定时 DAG)、删除路径都调本函数,不再读作业行的 `glueJobName`
//   当权威(那个字段只是 home 名的展示副本)。
import { HOME_TARGET_ID, assertTargetId, isHome, toTargetSlug } from "@/lib/exec-env/target-id";

/** Glue `CreateJob.Name` 上限(AWS 文档:1–255 个字符)。 */
export const GLUE_JOB_NAME_MAX = 255;

/** home 名(存量口径,逐字节不变)。 */
export function glueJobBaseName(jobId: string): string {
  if (typeof jobId !== "string" || jobId.trim().length === 0) {
    throw new Error("glueJobBaseName:jobId 缺失 —— 作业名派生不接受空 id");
  }
  return `bgp-etl-${jobId.slice(-12)}`;
}

/**
 * 某 target 上该作业的 Glue 作业名。
 * · home ⇒ `bgp-etl-<id12>`(存量逐字节不变);
 * · 非 home ⇒ `bgp-etl-<id12>-<targetSlug>`(同 region 多 target 各一份,互不覆盖)。
 * 🔴 targetId 非法即抛(fail-closed):拼一个错名出去 = 在别处建垃圾作业还查不到。
 */
export function glueJobNameFor(jobId: string, targetId: string = HOME_TARGET_ID): string {
  const base = glueJobBaseName(jobId);
  if (isHome(targetId)) return base;
  const name = `${base}-${toTargetSlug(assertTargetId(targetId))}`;
  if (name.length > GLUE_JOB_NAME_MAX) throw new Error(`Glue 作业名超长(${name.length} > ${GLUE_JOB_NAME_MAX}):${name}`);
  return name;
}

/** 一个作业在其全部绑定 target 上的 Glue 作业名(删作业时一个不漏;绑定为空时按 home 算)。 */
export function glueJobNamesOf(jobId: string, targets: readonly string[]): Array<{ targetId: string; name: string }> {
  const list = targets.length > 0 ? Array.from(new Set(targets)) : [HOME_TARGET_ID];
  return list.map((t) => ({ targetId: t, name: glueJobNameFor(jobId, t) }));
}
