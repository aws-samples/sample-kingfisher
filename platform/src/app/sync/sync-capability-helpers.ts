// 同步向导新控件用到的纯函数(不依赖 React / antd,可单测)。
import { renderSyncTemplate, isValidBusinessTimezone, syncRunVars } from "@/lib/sync/run-vars";

/** 今天的 UTC 日期(预览用;运行时由脚本按业务日期 / 业务时区算)。 */
export function todayUtcDs(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * 预览用的「今天」:按表单里填的业务日期时区取当天日期(与运行时没带业务日期时脚本的取法同口径);
 * 没填 / 不合法 ⇒ UTC。返回实际用的时区,界面要把它写出来。
 */
export function previewToday(tz: unknown, now: Date = new Date()): { ds: string; tz: string } {
  const zone = typeof tz === "string" && tz.trim() && isValidBusinessTimezone(tz.trim()) ? tz.trim() : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return { ds: `${get("year")}-${get("month")}-${get("day")}`, tz: zone };
}

/** 预览渲染:合法 ⇒ { ok: 渲染结果 };不合法 ⇒ { error: 原因 }。 */
export function previewTemplate(text: string, ds: string): { ok: string } | { error: string } {
  try {
    return { ok: renderSyncTemplate(text, ds) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 变量 token 的字面量(拼接而成,避免被当作模板插值)。 */
export const varToken = (name: string) => "$" + "{" + name + "}";

/** 新增一条模板表名前的检查;返回错误说明(中文),合法返回 null。 */
export function checkTemplateTableEntry(tpl: string, target: string, existing: string[]): string | null {
  const name = tpl.trim();
  const tgt = target.trim();
  if (!name) return "请填写带日期变量的源表名";
  if (!name.includes("$" + "{")) return "表名里没有日期变量;普通表请在上面的清单里勾选";
  const r = previewTemplate(name, todayUtcDs());
  if ("error" in r) return r.error;
  if (existing.includes(name)) return "这个表名模板已经添加过了";
  if (!tgt) return "必须为它指定一个固定的目标表名";
  if (tgt.includes("$" + "{")) return "目标表名不能带变量";
  return null;
}

/** 实例匹配器用的固定业务日期:只决定每个变量渲染出来有几位数字,与真实日期无关。 */
const MATCHER_DS = "2026-01-15";
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 守卫 1:把带日期变量的表名变成「它的实例表」匹配器 —— 每个变量按固定日期渲染后数字一律换成 \d(位数不变),
 * 其余字符原样。`orders_${bizmonth}` ⇒ /^orders_\d\d\d\d\d\d$/,匹配 orders_202609 / orders_202610。
 * 客户为了看列结构把这类月表也勾成普通表 ⇒ 第 1 步行上打黄标提醒。模板不合法(未知变量 / 写法不完整)⇒ null。
 */
export function templateInstanceMatcher(tpl: string): RegExp | null {
  const vars = syncRunVars(MATCHER_DS);
  let pattern = "";
  let last = 0;
  for (const m of Array.from(tpl.matchAll(/\$\{([^}]*)\}/g))) {
    const name = m[1];
    if (!(name in vars)) return null;
    const at = m.index ?? 0;
    pattern += escapeRegExp(tpl.slice(last, at)) + escapeRegExp(vars[name]).replace(/[0-9]/g, "\\d");
    last = at + m[0].length;
  }
  const rest = tpl.slice(last);
  if (rest.includes("$" + "{") || last === 0) return null;
  pattern += escapeRegExp(rest);
  return new RegExp("^" + pattern + "$");
}

/** 这张源表是不是某个模板按日期渲染出来的实例;返回命中的模板名(没有 ⇒ null)。 */
export function templateInstanceOf(tableName: string, templates: string[]): string | null {
  for (const tpl of templates) {
    const re = templateInstanceMatcher(tpl);
    if (re && re.test(tableName)) return tpl;
  }
  return null;
}

/** 样例表的列映射复制给模板(逐行拷贝,模板从此有自己的一份;样例表之后被改也不牵连)。样例没有映射 ⇒ []。 */
export function cloneColumnMapping<T extends Record<string, unknown>>(rows: T[] | undefined): T[] {
  return (rows || []).map((row) => ({ ...row }));
}

