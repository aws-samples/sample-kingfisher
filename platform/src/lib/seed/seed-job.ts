// @kf-batch 50-CAPSEED-seed-dispatch
// 🔴 **造数作业的名字与形状**(纯函数、零 AWS)—— 平台侧唯一作者。
//
// 【这些作业从哪来】造数作业**不是**产品建的,是部署期(演示模式)由两支部署脚本建在**各自的区**:
//   · 主控区:`scripts/22-seed-game.sh` 建 `bgp-game-seed` —— 灌**源库**(RDS MySQL `gamedata`,DROP + 重建 7 张表);
//   · 其它区:`scripts/23-seed-game-region.sh <targetId>` 建 `bgp-game-seed-<targetId>` —— 写**该区湖**(Parquet)
//     并注册**该区** Glue 目录库 `gamedata`(源库只在主控区,跨区去读 = 数据出境,所以数据只能生在本区)。
//   生产模式部署**不建**它们(用户拍板「生产不造数」)⇒ 平台在生产里调造数只会得到「该区没有造数作业」,不会造出假数据。
// 【为什么名字在这里写一次】平台要「复用部署期那个作业」,就必须与脚本**逐字同名**;两边各写一份,
//   改一侧漏另一侧的症状是「接口 409 说作业不存在,而控制台里明明有」。判据 `seed-job-parity` 从两支脚本里
//   把名字抽出来与这里逐字比。
import { assertTargetId, isHome, isValidTargetId } from "@/lib/exec-env/target-id";

/** 主控区造数作业名(与 scripts/22-seed-game.sh 的 `--name` 逐字相同)。 */
export const HOME_SEED_JOB = "bgp-game-seed";
/** 其它区造数作业名前缀(与 scripts/23-seed-game-region.sh 的 `JOB="bgp-game-seed-$TARGET"` 逐字相同)。 */
export const REGION_SEED_JOB_PREFIX = "bgp-game-seed-";

/**
 * 某执行范围的造数**种类**:主控区灌源库(`source-db`)/ 其它区写该区湖(`region-lake`)。
 * 🔴 主控区与其它区是**两种作业**(灌源库 vs 写湖),不是同一个作业换个名字 —— 这一个分支是事实,不是缺省回落;
 *    「是不是主控区」在造数链路里**只判这一处**(作业名 / 参数 / 页面上的「会重写什么」都从它来)。
 */
export type SeedKind = "source-db" | "region-lake";
export function seedKindOf(targetId: string): SeedKind {
  return isHome(assertTargetId(targetId)) ? "source-db" : "region-lake";
}

/** 某执行范围的造数作业名。 */
export function seedJobNameFor(targetId: string): string {
  const t = assertTargetId(targetId);
  return seedKindOf(t) === "source-db" ? HOME_SEED_JOB : `${REGION_SEED_JOB_PREFIX}${t}`;
}

/** 造数这件事在 run 台账上的「对象」id(每区一个;手动那次记在它名下,定时那次记在调度对象名下)。 */
export function seedRunTaskId(targetId: string): string {
  return `seed_${assertTargetId(targetId)}`;
}

/** 台账 taskId 是不是「手动造数」那一类(监控页取日志 / 起名用)。 */
export function isSeedRunTaskId(taskId: string): boolean {
  const s = String(taskId || "");
  return s.startsWith("seed_") && isValidTargetId(s.slice("seed_".length));
}

/** 从手动造数的台账 taskId 反解执行范围。 */
export function targetOfSeedRunTaskId(taskId: string): string {
  if (!isSeedRunTaskId(taskId)) throw new Error(`不是造数台账 id:${JSON.stringify(taskId)}`);
  return assertTargetId(taskId.slice("seed_".length));
}

/**
 * 这次 StartJobRun 要带的参数(**纯函数**)。
 * 🔴 其它区显式传 `--datalake` = **描述符里该区的湖桶**:作业定义是部署期脚本写的快照,描述符才是落点真值;
 *    两者一旦不一致(换过桶 / 作业定义陈旧),宁可写进描述符说的那个桶,也不许写进作业里记着的另一个桶。
 * 主控区不带参数(灌源库的作业参数 = 源库连接,由部署期定死;平台不认识也不该改)。
 */
export function seedJobArguments(targetId: string, landing: { datalakeBucket: string }): Record<string, string> {
  if (seedKindOf(targetId) === "source-db") return {};
  if (!landing.datalakeBucket) throw new Error(`执行范围 ${targetId} 的描述符缺 datalakeBucket ⇒ 不知道造数写到哪个湖,拒绝启动`);
  return { "--datalake": landing.datalakeBucket };
}

/** Glue run 的终态(与 scripts/22、23 的轮询口径一致)。 */
export const SEED_TERMINAL_OK = "SUCCEEDED";
export const SEED_TERMINAL_BAD = ["FAILED", "ERROR", "STOPPED", "TIMEOUT"] as const;
