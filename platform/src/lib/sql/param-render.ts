// @kf-batch 50-W5-seg2-WP1
// 模块 37 — SQL 模板参数的安全渲染(值位置转义 / 白名单代入)。纯逻辑,Vitest 覆盖。
//
// 【来历】2026-09-05 用户拍板下线「数据服务」(模块 30;50 SPEC §3.9c / WORK-PACKAGES WP-1)。
//   原 lib/data-service/validate.ts 的 coerceParams / renderSql / CoerceResult 与 types.ts 的
//   ApiParam / ParamType **不是数据服务的私有物** —— BI 分析看板筛选器的 {{key}} 注入(lib/bi/query.ts)
//   复用它们做防注入渲染。⇒ 逐字节搬到这里(单作者;下方各段与原文件一字不差,搬家零行为变化),
//   数据服务的其余部分随 lib 删除;validateApiDefinition / validateParamDecl 只服务 DataApi 定义,随 lib 删,不在此。
//
// 【模块 37 R2 铁律 —— 为什么这层必须存在】筛选器 / 参数值只允许落在 SQL 的【值位置】:
//   · string:单引号转义('→'')并用单引号包裹成字符串字面量,绝不裸拼;
//   · number:Number() 归一后代入;
//   · identifier / enum:只允许白名单(enumValues)命中的值原样代入 —— 标识符位置的唯一合法来源是白名单,
//     绝不把任意字符串拼进表名 / 列名(BI 筛选器的 select 类型在调用方先做 options 白名单校验,再按 string 渲染)。
//   未提供而模板用到的占位 → 抛错(由调用方转 400)。

export type ParamType = "string" | "number" | "identifier" | "enum";

export interface ApiParam {
  name: string; // {{name}} 占位名,[a-z][a-z0-9_]*
  type: ParamType;
  required?: boolean;
  description?: string;
  default?: string | number; // 缺省值(未传时填充)
  enumValues?: string[]; // type=enum / identifier 时的白名单(标识符必须走白名单,防注入)
  pattern?: string; // type=string 的额外正则约束(整串匹配)
  min?: number; // type=number 范围
  max?: number;
}

const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

// ── B) 调用期:校验 + 强制转换传入参数 ─────────────────────────────────────
export interface CoerceResult {
  ok: boolean;
  values?: Record<string, string | number>; // 安全值映射,供渲染
  error?: string;
}

// raw: 外部传入的原始参数(全部当字符串处理,GET query / POST body)。
export function coerceParams(params: ApiParam[], raw: Record<string, unknown>): CoerceResult {
  const values: Record<string, string | number> = {};
  for (const p of params) {
    let v = raw[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.default !== undefined) {
        values[p.name] = p.default;
        continue;
      }
      if (p.required) return { ok: false, error: `缺少必填参数:${p.name}` };
      continue; // 非必填且无默认:跳过(模板里若用到会在渲染期报未提供)
    }
    const s = String(v);
    switch (p.type) {
      case "number": {
        const n = Number(s);
        if (!Number.isFinite(n)) return { ok: false, error: `参数 ${p.name} 应为数字` };
        if (p.min !== undefined && n < p.min) return { ok: false, error: `参数 ${p.name} 小于最小值 ${p.min}` };
        if (p.max !== undefined && n > p.max) return { ok: false, error: `参数 ${p.name} 超过最大值 ${p.max}` };
        values[p.name] = n;
        break;
      }
      case "identifier":
      case "enum": {
        // 必须命中白名单(防注入的关键)。
        if (!p.enumValues || !p.enumValues.includes(s))
          return { ok: false, error: `参数 ${p.name} 取值非法(必须是允许值之一)` };
        values[p.name] = s;
        break;
      }
      case "string":
      default: {
        if (p.pattern && !new RegExp(`^(?:${p.pattern})$`).test(s))
          return { ok: false, error: `参数 ${p.name} 不符合格式要求` };
        if (s.length > 4096) return { ok: false, error: `参数 ${p.name} 过长` };
        values[p.name] = s;
        break;
      }
    }
  }
  return { ok: true, values };
}

// 安全渲染:把 {{param}} 替换为安全值。
//  - number / identifier(白名单) / enum(白名单):直接代入(已校验安全)。
//  - string:单引号转义('->'')并用单引号包裹,作为 SQL 字符串字面量(值位置),杜绝注入。
// 未提供且模板用到的占位 → 抛错(由调用方转 400)。
export function renderSql(sqlTemplate: string, params: ApiParam[], values: Record<string, string | number>): string {
  const typeOf = new Map(params.map((p) => [p.name.toLowerCase(), p.type]));
  return sqlTemplate.replace(PLACEHOLDER_RE, (_m, nameRaw) => {
    const name = String(nameRaw).toLowerCase();
    if (!(name in lowerKeys(values))) throw new Error(`未提供参数 {{${nameRaw}}}`);
    const val = lowerKeys(values)[name];
    const t = typeOf.get(name);
    if (t === "number") return String(Number(val));
    if (t === "identifier" || t === "enum") return String(val); // 已白名单校验
    // string:转义为安全 SQL 字符串字面量
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

function lowerKeys(o: Record<string, string | number>): Record<string, string | number> {
  const r: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(o)) r[k.toLowerCase()] = v;
  return r;
}
