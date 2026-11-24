// 同步通道 × 执行区:**哪个通道在哪个执行区可用**(唯一作者)。
//
// 【为什么存在】2026-11 之前这条规则只活在两个启动路由里(409「尚未逐区下推」):向导照常推荐、保存照常成功,
//   用户点「启动」才知道这个区用不了这个通道 —— 「能存不能启」。规则收到这里,向导的通道推荐、保存(新建 / 修改 /
//   Copilot 建草稿)与启动共用同一份:不可用就在选的时候置灰并写明原因,保存即拒。
//
// 现状(与各通道的实现逐条对应):
//   · Glue  —— 每个执行区都有(作业跑在该区);
//   · DMS   —— 每个执行区都有(复制实例 / 端点 / 复制任务建在任务绑定的区,见 lib/realtime/dms-place.ts);
//             该区实时基建缺项(没重新部署过)在启动时点名,不在这里判 —— 这里只回答「这个区原则上提供不提供」;
//   · Zero-ETL —— 只在主控区(托管集成写的是主控区里一个独立的数仓命名空间)。
// 🔴 以通道闭合清单为键的 Record:新增一种通道不填规则 ⇒ 编译错。
import { isHome } from "@/lib/exec-env/target-id";
import type { ApiErrorCode } from "@/lib/api-response";
import type { SyncTask } from "@/types/sync-task";

export type SyncChannel = SyncTask["channel"];

/** 保存 / 修改时通道在该区不可用的错误码。 */
export const CHANNEL_NOT_AVAILABLE_CODE = "CHANNEL_NOT_AVAILABLE_IN_REGION" satisfies ApiErrorCode;

const CHANNEL_PLACE_RULES: Record<SyncChannel, (targetId: string) => string | null> = {
  glue: () => null,
  dms: () => null,
  "zero-etl": (targetId) =>
    isHome(targetId)
      ? null
      : `Zero-ETL 通道目前只在主控区提供;执行环境 ${targetId} 的数据源请改用 DMS 通道(增量 / 实时)或 Glue 通道`,
};

/**
 * 按通道名取规则走这张 Map,不拿名字去做对象下标:通道名来自请求体,Map 里只有规则表自己的三个键,
 * 继承来的键名(`constructor` / `__proto__` / `toString` …)查不到,也就不会被当成规则去调用。
 */
const RULE_BY_CHANNEL: ReadonlyMap<string, (targetId: string) => string | null> = new Map(Object.entries(CHANNEL_PLACE_RULES));

/** 该通道在该执行区不可用的原因;可用 ⇒ `null`。通道不认识 ⇒ `null`(「通道合不合法」由各自的校验管,这里只管落点)。 */
export function channelUnavailableReason(channel: unknown, targetId: string): string | null {
  const rule = typeof channel === "string" ? RULE_BY_CHANNEL.get(channel) : undefined;
  // 按请求里的名字查出来的东西,调用之前先核它是函数:名字不认识时查到的是 `undefined`,不调用。
  if (typeof rule !== "function") return null;
  return rule(targetId);
}

export interface ChannelOption {
  channel: string;
  supported: boolean;
  recommended: boolean;
  reason: string;
}
export interface ChannelRecommendation {
  recommended: string;
  options: ChannelOption[];
}

/**
 * 把「按源 / 目标 / 模式」得出的通道推荐,再按数据源所在的执行区过一遍:该区不提供的通道 ⇒ 不支持并写明原因;
 * 原来推荐的正好是它 ⇒ 改推该区提供且支持的那个(DMS 优先于 Glue:被换掉的只可能是增量场景的 Zero-ETL)。
 */
export function applyChannelPlace(rec: ChannelRecommendation, targetId: string): ChannelRecommendation {
  let demoted = false;
  const options = rec.options.map((o) => {
    const why = channelUnavailableReason(o.channel, targetId);
    if (!why) return { ...o };
    if (o.recommended) demoted = true;
    return { ...o, supported: false, recommended: false, reason: why };
  });
  if (demoted && !options.some((o) => o.recommended)) {
    const next = options.find((o) => o.channel === "dms" && o.supported) ?? options.find((o) => o.supported);
    if (next) next.recommended = true;
  }
  const recommended = options.find((o) => o.recommended)?.channel ?? "";
  return { recommended, options };
}
