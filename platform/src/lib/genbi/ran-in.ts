// @kf-batch 50-B26-lake-place
// 问数结果「这次 SQL 实际在哪执行」的**呈现口径单一作者**(客户端安全:不引任何 AWS SDK)。
//
// 🔴🔴 B-25/B-26(2026-10-01 无头实测):在 us-west-2 视角选「数据湖」问数,10 条 Athena 查询全部打在主控区,
//   页面横幅照样写「当前在 us-west-2 提问」,答案区没有一个字说明实际在哪执行 ⇒ 用户拿到主控区的数据当成 us-west-2 的。
//   横幅是**请求侧声称**;这里呈现的是**执行层回报**(`_meta.ranIn`),两者不一致必须当场红字说出来。
import type { RanInMeta } from "@/lib/ai/meta";
import { interpolate, type TransParams } from "@/lib/i18n/translate";

/** 封闭三态:没回报 / 与视角一致 / 与视角不一致(或混了别的区)。 */
export type RanInView =
  | { kind: "unreported" }
  | { kind: "match"; regions: string[]; items: RanInMeta[] }
  | { kind: "mismatch"; regions: string[]; items: RanInMeta[]; expected: string };

/**
 * @param ranIn    结果 `_meta.ranIn`(执行层回报)
 * @param expected 这次提问应当落在的 region(视角所在区);未知则传 `null` —— 🔴 未知时**不许**判成一致,只呈现事实
 */
export function ranInView(ranIn: readonly RanInMeta[] | undefined, expected: string | null): RanInView {
  const items = (ranIn || []).filter((r) => r && typeof r.region === "string" && r.region);
  if (!items.length) return { kind: "unreported" };
  const regions = Array.from(new Set(items.map((r) => r.region)));
  if (expected && regions.some((r) => r !== expected)) return { kind: "mismatch", regions, items, expected };
  return { kind: "match", regions, items };
}

/** 一条落点的人话:「us-west-2 · 数据湖 Athena 工作组 bgp-athena-tgt-usw2-a」。`tr` = 页面的 `t`(中文即 key;不给 = 中文原样插值)。 */
export function ranInLabel(r: RanInMeta, tr: (zh: string, p?: TransParams) => string = interpolate): string {
  const key = r.engine === "athena" ? "{region} · 数据湖 Athena 工作组 {wg}" : "{region} · 数据仓库 Redshift 工作组 {wg}";
  return tr(key, { region: r.region, wg: r.workgroup });
}
