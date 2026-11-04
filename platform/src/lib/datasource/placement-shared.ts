// @kf-batch 50-W3f-T0-T3
// 数据源落点(placement)的**零依赖**共享常量 —— 类型 / 写入方 / 迁移 / 契约漂移门禁共用同一份真值。
// (拆出来是为了让 contract-drift 那类纯文本门禁能 import,而不把 DDB 客户端拉进测试。)
// `target-id` 本身零依赖(无 import),引它不破坏「零依赖」这条。
import { targetOfStamp } from "@/lib/exec-env/target-id";

/** `bgp-datasources` 行上的属性名:这条数据源归属 / 可达于哪个执行目标。 */
export const DATASOURCE_OWNER_TARGET_ATTR = "ownerTargetId" as const;

// @kf-batch 50-o4REG-sync-om-per-target
/**
 * 数据源行的落点(唯一读法)。存量源无章 = 主控区(补维前所有源都在主控区可达,历史事实);章非法 ⇒ 抛。
 * 🔴 同步启动(跨区取数卡)与 OM 回填重放(源表 service)共用这一个读法 —— 两处各写一份默认值就是两个作者。
 */
export function datasourceOwnerTarget(ds: Record<string, unknown> | null | undefined): string {
  // 存量无章 ⇒ 主控区 / 章非法 ⇒ 抛:由记录章的唯一作者 `targetOfStamp` 判(WP-31 序 3),这里不另写一份推理
  return targetOfStamp(ds ? ds[DATASOURCE_OWNER_TARGET_ATTR] : undefined);
}
