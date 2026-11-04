// @kf-batch 50-WP15-airflow-serverless(施工序 6)
// 调度器偏好的**值域 SSOT**(SPEC v3.27 §3.15:两者都装 ⇒ prefer ?? 描述符 schedulerPreference ?? serverless)。
// 低层模块:registry 的 zod、lifecycle 的写通道、mwaa-endpoint 的解析、前端开关都从这里取,不各自手抄字面。
// 🔴 2026-09-20 起**不再是「零依赖」** —— 它 import 了 `implemented-components.isComponentRetired`,
//   因为「可写值域」必须从「组件停供」派生(理由见下面 WP-20b 那段:绝不要第二份停供清单)。
import { isComponentRetired } from "@/lib/exec-env/implemented-components";

export const SCHEDULER_PREFERENCES = ["serverless", "mwaa"] as const;
export type SchedulerPreference = (typeof SCHEDULER_PREFERENCES)[number];
export function isSchedulerPreference(v: unknown): v is SchedulerPreference {
  return typeof v === "string" && (SCHEDULER_PREFERENCES as readonly string[]).includes(v);
}

// @kf-batch 50-WP20b-retire-mwaa-preference
// 🔴🔴 **读侧值域与写侧值域必须分开**(2026-09-20 真环境判据逮到)。
//
// 【缺陷】用户 2026-09-20 重申:「我们后面所有的调度都走 mwaa serverless」。经典 MWAA 已按 WP-20
//   **整体下线** —— 注册带 `mwaa` 回 400、补装那一行禁用并写「已停止提供」、账号里连 `BgpMwaaStack`
//   都没有。可**调度器偏好这条旁路没关**:`POST .../scheduler-preference` 只校验「取值在枚举里」,
//   于是往一个**只装了 serverless** 的 target 写 `schedulerPreference="mwaa"` 会**成功**(实测 HTTP 200,
//   描述符真写成 mwaa)⇒ 描述符从此**宣称一个不存在的调度器**。
//   承重行为当时还是对的(发布仍走 serverless、绝不往 MWAA 桶落 DAG,同批判据已断),
//   但这正是「界面/章宣称了一个没有载体的东西」那一类 —— 与同步任务「启用调度」空壳(WP-26)同族。
//   🔴 根因不是「少了一条『装了没有』的校验」,而是**下线只做了一半**:入口关了,而**值域**没关。
//
// 【根治】把「能读到什么」与「能写进什么」拆成两个值域:
//   · `SCHEDULER_PREFERENCES`(上面那个)= **读侧**,存量描述符里可能真存着 `mwaa`(历史双装目标),
//     解析侧照旧认它 ⇒ 零回归;
//   · `WRITABLE_SCHEDULER_PREFERENCES` = **写侧**,只剩 `serverless`。
//   写入校验放在**唯一写通道** `lifecycle.setSchedulerPreference` 里(不是只在路由上),
//   于是任何新调用方都自动被管住(枚举违规写法会漏第 N+1 个,列唯一合法形态不会)。
//   🔴🔴 而「哪个取值停供」**绝不再手写第二份清单** —— 仓里已经有唯一作者
//   `implemented-components.RETIRED_COMPONENTS`(同一条理由、同一个先例:「读侧保留 / 写侧拒」,
//   连拒因人话都已经有 `retiredComponentMessage`)。偏好值与组件是一一对应的,
//   所以可写值域**从组件停供派生**:哪天再停供一个调度器,两边自动一起变。
//   (本文件因此不再是「零依赖叶子」—— 换来的是**不会漂的两份清单**,这笔买卖划算:
//    本轮修掉的缺陷里有一半就是「同一件事两份清单」。`implemented-components` 零 import,不会成环。)

/** 偏好值 → 它依赖的那个组件(唯一映射:解析侧、写侧、前端都从这里取)。 */
export const SCHEDULER_PREFERENCE_COMPONENT: Record<SchedulerPreference, string> = {
  serverless: "airflow-serverless",
  mwaa: "mwaa",
};

/** 可**写入**的偏好取值 = 它依赖的组件**没有停供**。
 *  🔴 刻意**不写成类型谓词**(`v is SchedulerPreference`):那会让 `else` 分支里的取值被收窄成 `never`,
 *    于是「渲染已停供那一项的标签」这种正当代码直接编译不过(第一版就是这样)。
 *    判「可不可写」与判「是不是合法取值」是两件事,不该共用一次收窄。 */
export function isWritableSchedulerPreference(v: unknown): boolean {
  return isSchedulerPreference(v) && !isComponentRetired(SCHEDULER_PREFERENCE_COMPONENT[v]);
}
export const WRITABLE_SCHEDULER_PREFERENCES: readonly SchedulerPreference[] =
  SCHEDULER_PREFERENCES.filter((p) => isWritableSchedulerPreference(p));
/** 已停供的偏好取值(读得到、写不进)。 */
export const RETIRED_SCHEDULER_PREFERENCES: readonly SchedulerPreference[] =
  SCHEDULER_PREFERENCES.filter((p) => !isWritableSchedulerPreference(p));
/** 拒因人话 + 出路(路由与写通道共用一句,不许各写一份)。 */
export function retiredSchedulerPreferenceMessage(v: string): string {
  return (
    `调度器偏好不能设成 ${v}:经典 MWAA 已停止提供(WP-20),` +
    `后续所有调度统一走 MWAA Serverless。` +
    `当前可写的取值只有 ${WRITABLE_SCHEDULER_PREFERENCES.join(" / ")}。` +
    `存量描述符里已经存着 ${v} 的历史目标仍按原样解析(不改它已发布的产物)。`
  );
}
export const SCHEDULER_PREFERENCE_LABEL: Record<SchedulerPreference, { label: string; desc: string }> = {
  serverless: { label: "Serverless", desc: "MWAA Serverless:按任务秒计费、零常驻(默认)" },
  mwaa: { label: "MWAA", desc: "经典 MWAA 环境(常驻)" },
};
