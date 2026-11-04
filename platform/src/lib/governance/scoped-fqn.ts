/**
 * **治理记录的区维** —— 「哪个区的哪张表」的唯一键构造处。
 *
 * ## 问题
 * 目录里的 fqn 是 `redshift.<database>.<schema>.<table>` / `glue.<db>.<table>`,**不含区**。
 * 而治理四张表全部按 fqn 分区:
 *   · `bgp-data-classification`  pk=fqn, sk=column
 *   · `bgp-quality-rules`        pk=fqn, sk=ruleId
 *   · `bgp-quality-results`      pk=fqn, sk=<runId>#<ruleId>
 *   · `bgp-lineage`              pk=targetFqn, sk=sourceFqn
 * ⇒ 两个区里同名的表(几乎必然同名 —— 同一套建模落到每个区)**共用同一个分区**:
 * 一个区打的敏感级别会盖掉另一个区的;一个区跑绿、另一个区跑红的质量结果互相覆盖;
 * 血缘图把两个区的同名表画成同一个节点。用户 2026-09-10 的原话是「同名表跨区会互相顶,
 * 按区出分会**串味**」。
 *
 * ## 修法与为什么是这一种
 * 给**分区键**加区前缀:`<targetId>::<fqn>`,而 **home 保持裸 fqn**。
 *   · 🔴 home 裸 fqn ⇒ **存量行一个字节都不用动**(零迁移)。落章之前平台只有一个区,
 *     那些行属于主控区是历史事实,不是猜测;
 *   · 分隔符用 `::`:fqn 里是点、targetId 里是下划线,`::` 在两者中都不会出现 ⇒ 解析无歧义;
 *   · 🔴 **不改表的键结构**(那要动 CDK + 迁移全部存量);也**不**把区塞进排序键 ——
 *     classification 的 sk 是 `column`、lineage 的 sk 是 `sourceFqn`,塞进去会让这两个字段名开始说谎
 *     (本仓在复合键上踩过的坑:R10 审查「复合键必要不充分」)。
 *   · 🔴 也**不**在行上另存一个 `targetId` 属性当真值:那就有两个真值源(键里一个、属性里一个),
 *     写的时候漏同步一处就出现「键在 A 区、属性说 B 区」的行,而任何一侧的读都自认为是对的。
 *     要显示区的时候从键里解出来(`parseScopedFqn`)。
 */
import { HOME_TARGET_ID, isHome, isValidTargetId } from "@/lib/exec-env/target-id";
import { parseScope } from "@/lib/scope/scope";

export const SCOPED_FQN_SEP = "::";

/**
 * fqn + 落点 → 治理表的分区键。
 * 🔴 `targetId` 缺省 / 是主控区 ⇒ **原样返回 fqn**(回滚点:与改动前逐字节相同)。
 * 🔴 非法 targetId ⇒ **抛**,不静默退回裸 fqn:退回的后果是那条治理记录写进了主控区的分区,
 * 从此和主控区的记录互相覆盖 —— 正是这一刀要修的病。
 */
export function scopedFqn(fqn: string, targetId?: string | null): string {
  const f = (fqn || "").trim();
  if (!f) throw new Error("scopedFqn:fqn 不能为空");
  if (!targetId || isHome(targetId)) return f;
  if (!isValidTargetId(targetId)) {
    throw new Error(
      `scopedFqn:非法 targetId ${JSON.stringify(targetId)} —— 拒绝退回裸 fqn(那会让这条治理记录` +
        `写进主控区的分区,从此与主控区的记录互相覆盖)`
    );
  }
  // 已经带前缀的键原样返回(幂等:调用方可能已经拿到的是 scoped 键)
  if (f.includes(SCOPED_FQN_SEP)) return f;
  return `${targetId}${SCOPED_FQN_SEP}${f}`;
}

/** 分区键 → { fqn, targetId }。裸 fqn ⇒ 主控区(与写侧同一条约定)。 */
export function parseScopedFqn(key: string): { fqn: string; targetId: string } {
  const k = (key || "").trim();
  const i = k.indexOf(SCOPED_FQN_SEP);
  if (i < 0) return { fqn: k, targetId: HOME_TARGET_ID };
  return { targetId: k.slice(0, i), fqn: k.slice(i + SCOPED_FQN_SEP.length) };
}

/** 给人看的 fqn(把区前缀去掉;区本身另用标签显示,不混在表名里)。 */
export function displayFqn(key: string): string {
  return parseScopedFqn(key).fqn;
}

/** 这个键属于当前范围吗(裸 fqn = 主控区)。 */
export function scopedFqnInTargets(key: string, targets: readonly string[]): boolean {
  if (targets.length === 0) return true;
  return targets.includes(parseScopedFqn(key).targetId);
}

/**
 * 从请求解析「这张表在哪个区」。
 *
 * 优先级:`?targetId=`(页面明确知道这张表是从哪个区的目录里点开的)> `?scope=` 的**单区**视角 >
 * 主控区。
 * 🔴 多区分组 / 全局视角**回主控区**而不是随便挑一个:治理动作是**写一张具体表的元数据**,
 * 「在一个分组上打敏感标签」没有意义 —— 那会把标签写到分组里第一个区上,而用户以为写的是全部。
 * 页面在多区视角下应当先让用户点开某一行(目录行知道自己是哪个区的)。
 */
export function governanceTargetFrom(params: URLSearchParams): string {
  const tid = (params.get("targetId") || "").trim();
  if (tid && isValidTargetId(tid)) return tid;
  // 🔴 `?scope=` 的文法只有一个作者(`lib/scope/scope.ts` 的 `parseScope`)——
  // 在这里重写一份「怎么算单区」必然与它漂移(实测:单区形态是**裸 targetId**,
  // 我第一版按 `target:` 前缀猜的,那种串 parseScope 根本不认)。
  const sc = parseScope(params.get("scope"));
  if (sc && sc.kind === "target") return sc.targetId;
  return HOME_TARGET_ID;
}
