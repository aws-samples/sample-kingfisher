// @kf-batch 50-WP5-rungroup
// 「≤ 某个时刻的**最近一个 cron 触发点**」—— 定时确定性组键的时间轴(50 SPEC v3.44 §3.17.2)。
//
// ══════════════════════════════════════════════════════════════════════════════
// 🔴 为什么要自己算而不是用调度器给的时间(这一条是本文件存在的全部理由)
//   · Airflow 的 `run_id` / `logical_date` 在 **MWAA Serverless 下退化成常量**
//     (实测两次不同 run 都是 `scheduled__2026-09-07T00:00:00+00:00`;
//      `lib/scheduler/serverless/runtime-py.ts` 的 `_ledger_run_id` 记着这条真环境事实)。
//     拿它当分组时间的故障形态是 **所有历次定时归进同一个组、且那个组永不终态**。
//   · `AIRFLOW_CTX_DAG_ID`(`ex_<uuid>`)每次 run 都不同 —— 但**每个区也都不同**,跨区归不了组。
//   · 直接取墙上时钟的秒:两个区的触发瞬间差几百毫秒 ⇒ **每次都是两个组**(恒不成组)。
//   ⇒ 唯一稳的办法:各区**各自**把自己的触发时刻**下取整到 cron 槽位**。两个区都在同一个触发点
//     之后被叫起来 ⇒ 落同一个槽位;要错开必须有一个区延迟**超过一整个 cron 周期**(日频 = 24h),
//     那本身就是该报的故障。
// 🔴 本文件的 Python 孪生由 `pythonCronSlotSource()` **唯一产出**(parity 单测逐字节比对两侧结果)——
//   两个语言各写一份的下场见 `bug-fix-dual-track-cookbook`:只改执行侧挡不住生成侧。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 往回找的上界(天)。找不到就抛 —— 「猜一个时间」比失败危险得多(键会静默错开)。
 *
 * 🔴 **1500 天不是随手取的**:第一版写 366 天,parity 用例 `0 0 29 2 *`(闰日)当场两侧一起失败 ——
 * 最近的一个 2/29 可能在 **2 年多以前**。要覆盖闰年周期(4×366)再留余量才行。
 * 上界唯一还会触发的情形 = **压根不存在的 cron**(如 `0 0 30 2 *`),那时两侧都如实抛。
 */
export const CRON_SLOT_HORIZON_DAYS = 1500;

export class CronExprInvalid extends Error {
  constructor(expr: string, why: string) {
    super(`cron 表达式非法(${why}):${JSON.stringify(expr)}`);
    this.name = "CronExprInvalid";
  }
}

export class CronSlotNotFound extends Error {
  constructor(expr: string) {
    super(`往回 ${CRON_SLOT_HORIZON_DAYS} 天都没有匹配 ${JSON.stringify(expr)} 的触发点 ⇒ 拒绝猜一个时间`);
    this.name = "CronSlotNotFound";
  }
}

interface Field {
  values: Set<number>;
  wildcard: boolean;
}

const RANGES: Array<[number, number]> = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 6], // 周(0 = 周日;7 也接受并归一成 0)
];

function parseField(raw: string, idx: number, expr: string): Field {
  const [lo, hi] = RANGES[idx];
  const values = new Set<number>();
  const wildcard = raw === "*";
  for (const part of raw.split(",")) {
    const [spec, stepRaw] = part.split("/");
    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw)) throw new CronExprInvalid(expr, `步长非法 ${part}`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) throw new CronExprInvalid(expr, `步长必须 ≥1 ${part}`);
    let from: number;
    let to: number;
    if (spec === "*") {
      from = lo;
      to = hi;
    } else if (/^\d+$/.test(spec)) {
      from = Number(spec);
      to = stepRaw === undefined ? from : hi;
    } else {
      const m = spec.match(/^(\d+)-(\d+)$/);
      if (!m) throw new CronExprInvalid(expr, `字段非法 ${part}`);
      from = Number(m[1]);
      to = Number(m[2]);
    }
    // 周字段:7 归一成 0(两种写法都指周日)
    if (idx === 4) {
      if (from === 7) from = 0;
      if (to === 7) to = 0;
    }
    if (from < lo || to > hi || from > to) throw new CronExprInvalid(expr, `越界或反向 ${part}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  if (values.size === 0) throw new CronExprInvalid(expr, `字段解析出空集 ${raw}`);
  return { values, wildcard };
}

export interface ParsedCron {
  min: Field;
  hour: Field;
  dom: Field;
  mon: Field;
  dow: Field;
}

export function parseCron(expr: string): ParsedCron {
  const parts = String(expr ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new CronExprInvalid(expr, `必须是 5 段,收到 ${parts.length} 段`);
  const [min, hour, dom, mon, dow] = parts.map((p, i) => parseField(p, i, expr));
  return { min, hour, dom, mon, dow };
}

/**
 * 某个 UTC 时刻是不是 cron 的触发点。
 * 🔴 **日 / 周两个字段是「或」**(Vixie cron 的既定语义:两者都被限定时,任一命中即触发)。
 *    这一条必须与 Python 侧逐字一致,否则两个区会在「周一 1 号」这种日子分出两个组。
 */
export function cronMatchesUtc(c: ParsedCron, d: Date): boolean {
  if (!c.min.values.has(d.getUTCMinutes())) return false;
  if (!c.hour.values.has(d.getUTCHours())) return false;
  if (!c.mon.values.has(d.getUTCMonth() + 1)) return false;
  const domHit = c.dom.values.has(d.getUTCDate());
  const dowHit = c.dow.values.has(d.getUTCDay());
  if (c.dom.wildcard && c.dow.wildcard) return true;
  if (c.dom.wildcard) return dowHit;
  if (c.dow.wildcard) return domHit;
  return domHit || dowHit;
}

/** 规范化到秒的 UTC(`YYYY-MM-DDTHH:MM:SSZ`)—— 两侧必须**逐字节**一致,所以不用任何 locale/库。 */
export function toSlotIso(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
  );
}

/** 「≤ `at` 的最近一个 cron 触发点」,规范化到秒的 UTC 字符串。 */
export function cronSlotIso(expr: string, at: Date): string {
  const c = parseCron(expr);
  // 先把秒/毫秒抹掉(cron 的粒度是分钟)
  let ms = Math.floor(at.getTime() / 60000) * 60000;
  const steps = CRON_SLOT_HORIZON_DAYS * 24 * 60;
  for (let i = 0; i <= steps; i++) {
    const d = new Date(ms);
    if (cronMatchesUtc(c, d)) return toSlotIso(d);
    ms -= 60000;
  }
  throw new CronSlotNotFound(expr);
}
