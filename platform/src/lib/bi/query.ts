// BI 取数统一入口(纯逻辑,复用既有底座,不重造)。
//
// 三种 WidgetSource 归一到一个 executeBiQuery:
//  - sql / genbi:引擎分支 runSelect / runSelectAthena → **必过 maskRows**(R2 铁律)。
//  - dataapi:「数据服务」已于 2026-09-05 下线:**类型保留、能力下线**,
//    任何 dataapi 取数一律抛同一句 410(DATA_SERVICE_GONE),本文件不再 import data-service。
//
// 筛选器:仪表盘筛选器值以 {{key}} 注入 SQL,走 lib/sql/param-render 的安全渲染(值位置转义 / select 白名单),绝不裸拼。

import { requestedTargetId } from "@/lib/place/resolve";
import { targetOfStamp } from "@/lib/exec-env/target-id";
import { runSelect } from "@/lib/genbi/redshift";
import { runSelectAthena } from "@/lib/genbi/athena";
import { maskRows } from "@/lib/governance/masking";
import { GENBI } from "@/lib/genbi/config";
import type { ApiErrorCode } from "@/lib/api-response";
import type { Identity } from "@/lib/auth/identity";
// 共享件搬家:renderSql / coerceParams / ApiParam 从已下线的 data-service 搬到 lib/sql/param-render(逐字节)。
import { coerceParams, renderSql, type ApiParam } from "@/lib/sql/param-render";
import type { WidgetSource, DashboardFilter, BiQueryResult } from "./types";

const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

// 从 SQL 模板抽出用到的占位名(小写)。
function usedPlaceholders(sql: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(sql))) out.add(m[1].toLowerCase());
  return Array.from(out);
}

// 把仪表盘筛选器 + 运行期值,转成 ApiParam[] + 安全值映射,复用 renderSql 做值位置注入。
// 只处理 SQL 里实际用到的占位。筛选器注入的是 SQL 的【值位置】(如 WHERE region = {{region}}),故
// 一律按 string 渲染=单引号包裹的安全字符串字面量;select 类型先自行做白名单校验(命中才放行),再
// 交 renderSql 转义。注意:不能用 enum 类型——enum 是给「标识符位置」的裸替换(不加
// 引号),会把值 East 渲染成裸标识符导致 `column "east" does not exist`。
function renderWithFilters(
  sql: string,
  filters: DashboardFilter[] | undefined,
  values: Record<string, string> | undefined
): string {
  const used = usedPlaceholders(sql);
  if (used.length === 0) return sql; // 无占位:原样(自由 SQL 常见)

  const byKey = new Map((filters || []).map((f) => [f.key.toLowerCase(), f]));
  const params: ApiParam[] = [];
  const raw: Record<string, unknown> = {};
  for (const name of used) {
    const f = byKey.get(name);
    const v = values?.[name] ?? values?.[f?.key ?? name] ?? f?.default;
    // select:白名单校验(防注入的关键)——传了值就必须命中选项之一。
    if (f && f.type === "select" && f.options && f.options.length) {
      if (v !== undefined && v !== null && v !== "" && !f.options.includes(String(v))) {
        throw new Error(`筛选器「${f.label || f.key}」取值非法(必须是允许值之一)`);
      }
    }
    // 一律按 string 渲染=值位置的安全 SQL 字符串字面量(renderSql 会单引号转义)。
    params.push({ name, type: "string", required: false, default: f?.default });
    if (v !== undefined && v !== null && v !== "") raw[name] = String(v);
  }
  const coerced = coerceParams(params, raw);
  if (!coerced.ok) throw new Error(coerced.error || "筛选器参数非法");
  return renderSql(sql, params, coerced.values || {});
}

export interface BiQueryError {
  status: number;
  error: string;
  /** 可选机器码;路由有则透传、无则按 status 归类。(数据服务下线的 410 GONE 用) */
  code?: ApiErrorCode;
}

// dataapi 取数源的**唯一出口**(单一真值源):三条 BI 路由(bi/query / bi/analysis-query / bi/export)
// 与 executeBiQuery 的 dataapi 分支抛的都是这一个对象。🔴 只能是 410 + 这一句,不许在路由里各写一份文案(ACCEPTANCE「同一句」)。
export const DATA_SERVICE_GONE: BiQueryError = {
  status: 410,
  code: "GONE",
  error: "数据服务能力已于 2026-09 下线,该视觉对象请改为 SQL 或 GenBI 来源",
};

// 判定是否上游查询错误(超时映射 504,其余 502)。
function upstreamError(msg: string | undefined): BiQueryError {
  const m = msg || "查询失败";
  const isTimeout = /超时|timeout/i.test(m);
  return { status: isTimeout ? 504 : 502, error: m };
}

// 执行一个 widget 的取数。filters/filterValues 来自仪表盘筛选器(编辑期预览可为空)。
// 成功返回 BiQueryResult;失败抛 BiQueryError(带建议 HTTP status)。
/**
 * 一次 BI 取数的落点 —— 唯一作者。两种对象两条规则:
 *  · **已保存的视觉对象**(分析取数 / 导出 CSV):落点是它**自己的章** —— 新建时单区视角写进 `source.targetId`,
 *    「全部」视角新建的不写字段 = 主控区(AnalysisWorkbench 的约定)⇒ 走 targetOfStamp,与页面当前视角无关
 *    (否则跨区并排的仪表盘切区时整张变成同一个区的数据);
 *  · **未保存的预览**(/api/bi/query):自带的赢,否则必须由请求点名;都没有 ⇒ PlaceUndecidable(400)。
 */
export function biLandingOf(source: unknown, requested: unknown, kind: "saved" | "preview"): string {
  const own = (source as { targetId?: unknown } | null | undefined)?.targetId;
  if (kind === "saved") return targetOfStamp(own);
  if (typeof own === "string" && own.trim()) return requestedTargetId(own, "图表自带的落点");
  return requestedTargetId(requested, "BI 取数");
}

export async function executeBiQuery(
  source: WidgetSource,
  opts: {
    identity: Identity | null;
    correlationId: string;
    filters?: DashboardFilter[];
    filterValues?: Record<string, string>;
    /**
     * 取数落点。优先级:**widget 自己声明的 > 调用方传的 > 主控区**。
     * 🔴 为什么 widget 优先:仪表盘是**跨区并排**的(SPEC §8.3),页面范围只是默认值;
     * 让页面范围盖掉 widget 的声明会让「保存好的跨区仪表盘」在切区时整张变成同一个区的数据。
     * 🔴 调用方**必填**(原来两者都没有 = 主控区):路由从请求里点名取。
     */
    targetId: string;
    /** 非主控区数仓凭证按项目发(§3.9b),必填(原来不传 ⇒ 非主控区取数被落点解析当场拒) */
    projectId: string;
  }
): Promise<BiQueryResult> {
  const t0 = Date.now();

  // ── dataapi:能力已下线(2026-09-05)—— 类型仍在联合里(存量行不炸),取数一律 410 同一句 ──────────
  if (source.kind === "dataapi") throw DATA_SERVICE_GONE;

  // ── sql / genbi:引擎分支 + 必过脱敏 ──────────────────────────────────────
  const engine = source.engine;
  // widget 自己声明的落点赢(见 opts.targetId 注释)
  const targetId = (source as { targetId?: string }).targetId || opts.targetId;
  let sql: string;
  try {
    sql = renderWithFilters(source.sql, opts.filters, opts.filterValues);
  } catch (e) {
    throw { status: 400, error: e instanceof Error ? e.message : String(e) } as BiQueryError;
  }

  let columns: string[] = [];
  let columnTypes: string[] | undefined;
  let rows: unknown[][] = [];
  try {
    if (engine === "athena") {
      const r = await runSelectAthena(sql, { targetId });
      if (!r.success) throw upstreamError(r.error);
      columns = r.columns;
      columnTypes = r.columnTypes;
      rows = r.rows;
    } else {
      // 🔴 非主控区**不许**把 GENBI.workgroup / GENBI.database 传下去:那是主控区的实名,
      // 传了就会覆盖落点解析出来的该区工作组(`runSelect` 的口径是「调用方显式给的赢」)
      // ⇒ region 对了、工作组还是主控区的 = 连到别的区去查一个不存在的工作组。
      // 工作组 / 库由落点作者解析(主控区解析出的就是 GENBI 那对 —— 同源 homeWorkgroup / homeDatabase)
      const r = await runSelect(sql, "", "", { targetId, project: opts.projectId });
      if (!r.success) throw upstreamError(r.error);
      columns = r.columns;
      columnTypes = r.columnTypes;
      rows = r.rows;
    }
  } catch (e) {
    if (e && typeof e === "object" && "status" in e) throw e as BiQueryError;
    throw upstreamError(e instanceof Error ? e.message : String(e));
  }

  // R2 铁律:直查结果返回前端前必须过 maskRows(best-effort,不改契约)。
  let maskedColumns: string[] = [];
  try {
    const m = await maskRows({
      columns: columns.map((name) => ({ name })),
      rows,
      sql,
      database: GENBI.database,
      identity: opts.identity,
    });
    rows = m.rows;
    maskedColumns = m.maskedColumns;
  } catch {
    /* maskRows 内部 best-effort 返回原行;此处仅吞异常不改其契约 */
  }

  return { columns, columnTypes, rows, rowCount: rows.length, elapsedMs: Date.now() - t0, maskedColumns };
}

// dataapi 来源的取数入口:三条 BI 路由的 dataapi 分支都调它。
// 「数据服务」下线后它**不再取数、不再 import data-service**:签名原样保留(路由零改动),
// 一律抛 DATA_SERVICE_GONE(410 同一句),由路由按 BiQueryError 透传 ⇒ 存量 dataapi 组件渲染「已下线」占位而不是 500 / 白屏。
export async function executeBiDataApi(
  _projectId: string,
  _apiId: string,
  _params: Record<string, string>,
  _identity: Identity | null,
  _correlationId: string
): Promise<BiQueryResult> {
  throw DATA_SERVICE_GONE;
}
