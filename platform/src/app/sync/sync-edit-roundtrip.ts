// 同步向导「再次编辑不丢东西」的纯函数(不依赖 React / antd,可单测;判据见 __tests__/sync-edit-roundtrip.test.ts)。
//
// 2026-11-26 客户反馈「变量表再次编辑,之前的变量表以及内容会消失」,页面复现出三条走法,这里管前两条:
//   ① 带日期变量的表名:新增行三个框填好了、没点「添加」就点「下一步 / 完成」⇒ 原来这三个框只是控件内部状态,不进保存请求、也不提示。
//      现在「添加」按钮与「下一步 / 完成」走同一个函数:三个框全空 = 没事;填了任何一个 ⇒ 校验过就收进来,不过就拦下并说明原因。
//   ② 列映射:原来再次编辑时按新读到的表清单整份重建(每列都开着、目标字段名回到缺省),点「完成」就把缺省写回去。
//      现在以任务里保存的那份为准合到新读到的列清单上。
import { checkTemplateTableEntry, cloneColumnMapping } from "./sync-capability-helpers";
import type { FieldMappingRow } from "./sync-task-payload";

/** 新增行的三个输入(受控,状态在向导里)。 */
export interface PendingTemplateEntry {
  /** 带日期变量的源表名 */
  tpl: string;
  /** 固定的目标表名 */
  target: string;
  /** 样例表(可不选) */
  sample?: string;
}

export const EMPTY_PENDING_TEMPLATE: PendingTemplateEntry = { tpl: "", target: "", sample: undefined };

/** 向导里与带日期变量的表名有关的四样状态(收进一条新的要同时动这四样)。 */
export interface TemplateWizardState {
  templateTables: string[];
  /** 带日期变量的源表名 → 样例表 */
  templateSamples: Record<string, string>;
  /** 每张表的列映射(带日期变量的那份由样例表复制而来) */
  fieldMappings: Record<string, FieldMappingRow[]>;
  /** 表单里的 targetTableNames(整个对象是一个字段) */
  targetTableNames: Record<string, unknown>;
}

/** 新增行三个框都没填。 */
export function isPendingTemplateEmpty(p: PendingTemplateEntry): boolean {
  return !String(p.tpl ?? "").trim() && !String(p.target ?? "").trim() && !String(p.sample ?? "").trim();
}

export type CommitTemplateResult =
  /** 三个框都空,且调用方不把「空」当错(「下一步 / 完成」)⇒ 什么都不做 */
  | { kind: "empty" }
  /** 填了但不合法 ⇒ 拦下;error 是给人看的原因(中文键,界面再过一遍译文) */
  | { kind: "error"; error: string }
  /** 收进来了;state 是收进来之后的四样状态(调用方直接用它,不等界面状态刷新) */
  | { kind: "committed"; name: string; state: TemplateWizardState };

/**
 * 把新增行收进任务。「添加」按钮(emptyIsError = true:空着点「添加」要提示先填)与「下一步 / 完成」
 * (emptyIsError = false:空着就是没有要加的)共用这一个函数 —— 校验只有 checkTemplateTableEntry 一份。
 */
export function commitTemplateEntry(pending: PendingTemplateEntry, state: TemplateWizardState, opts: { emptyIsError: boolean }): CommitTemplateResult {
  if (isPendingTemplateEmpty(pending) && !opts.emptyIsError) return { kind: "empty" };
  const error = checkTemplateTableEntry(String(pending.tpl ?? ""), String(pending.target ?? ""), state.templateTables);
  if (error) return { kind: "error", error };
  const name = pending.tpl.trim();
  const sample = String(pending.sample ?? "").trim();
  const next: TemplateWizardState = {
    templateTables: [...state.templateTables, name],
    templateSamples: { ...state.templateSamples },
    fieldMappings: { ...state.fieldMappings },
    targetTableNames: { ...state.targetTableNames, [name]: pending.target.trim() },
  };
  // 选了样例表 ⇒ 样例表的列映射复制给它(从此有自己的一份);没选 ⇒ 它在向导里暂时没有列
  if (sample) {
    next.templateSamples[name] = sample;
    next.fieldMappings[name] = cloneColumnMapping(state.fieldMappings[sample]);
  }
  return { kind: "committed", name, state: next };
}

/**
 * 再次编辑:把任务里保存的列映射合到新读到的列清单上。
 *   - 保存过的列 = 开着,目标字段名用保存的那个(保存的那一行自己标了不同步 ⇒ 关着);
 *   - 这张表保存过列映射、但这一列不在里面 = 关着(任务里只存「开着的列」:用户关掉的列与源库后来新增的列都在这一类);
 *   - 这张表在任务里没有列映射(没有这个键 / 是空的 / 一列都对不上)= 新读到的那份原样(全部开着);
 *   - 源库里已经没有的列不带回来(列清单以新读到的为准,类型也以新读到的为准)。
 * saved 不是对象 ⇒ fresh 原样返回。
 */
export function mergeSavedFieldMappings<T extends FieldMappingRow>(fresh: Record<string, T[]>, saved: unknown): Record<string, T[]> {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return fresh;
  const savedByTable = saved as Record<string, unknown>;
  const out: Record<string, T[]> = {};
  for (const [table, rows] of Object.entries(fresh)) {
    const savedRows = savedByTable[table];
    const bySource = new Map<string, Record<string, unknown>>();
    if (Array.isArray(savedRows)) {
      for (const r of savedRows) {
        if (r && typeof r === "object" && typeof (r as { source?: unknown }).source === "string") bySource.set((r as { source: string }).source, r as Record<string, unknown>);
      }
    }
    if (!rows.some((r) => bySource.has(String(r.source)))) { out[table] = rows; continue; }
    out[table] = rows.map((r) => {
      const s = bySource.get(String(r.source));
      if (!s) return { ...r, include: false };
      const target = typeof s.target === "string" && s.target.trim() ? s.target : r.target;
      return { ...r, include: s.include !== false, target };
    });
  }
  return out;
}
