// 平台侧的 PlaceWire **生产者**(读取函数本体在 lib/genbi/core/place-wire.ts,三个 JS 运行时同源)。
//
// 规矩:落点要跨运行时传递(AgentCore payload / 调度 spec / 生成的 Spark 脚本),**只许**经这里产出 PlaceWire;
// 产出时就用读取函数**自校验一遍** —— 生产者写出读取方不认的东西,在平台这一侧当场报错,而不是到了容器 / Lambda /
// Python 里才炸(或者更糟:被那边的缺省值吞掉)。
import { readPlaceWire, type PlaceWire } from "@/lib/genbi/core/place-wire";

export { readPlaceWire, placeWireLeg, PlaceWireInvalid } from "@/lib/genbi/core/place-wire";
export type { PlaceWire, PlaceWireRedshift, PlaceWireAthena } from "@/lib/genbi/core/place-wire";

export interface PlaceWireInput {
  targetId: string;
  region: string;
  /** 数仓腿;`secretArn` 为空 / null ⇒ 不写这个字段(读取方按「没有凭证 ARN」处理,不是空串) */
  redshift?: { workgroup: string; database: string; secretArn?: string | null };
  athena?: { workgroup: string; outputLocation: string; catalogRef: string };
}

/** 产出一个 PlaceWire(先归一、再用读取函数自校验;不合法 ⇒ 抛 PlaceWireInvalid)。 */
export function buildPlaceWire(input: PlaceWireInput): PlaceWire {
  const raw: Record<string, unknown> = { v: 1, targetId: input.targetId, region: input.region };
  if (input.redshift) {
    const r: Record<string, unknown> = { workgroup: input.redshift.workgroup, database: input.redshift.database };
    if (input.redshift.secretArn) r.secretArn = input.redshift.secretArn;
    raw.redshift = r;
  }
  if (input.athena) {
    raw.athena = { workgroup: input.athena.workgroup, outputLocation: input.athena.outputLocation, catalogRef: input.athena.catalogRef };
  }
  return readPlaceWire(raw);
}
