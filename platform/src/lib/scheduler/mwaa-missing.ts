// 客户端安全的「缺 MWAA」响应解析(零依赖:不 import 任何服务端模块,组件与页面都能用)。
// 服务端形状(50 SPEC v3.26 §2.1):{ success:false, error:{ code:"MWAA_NOT_INSTALLED", message, detail:{ missing:[…], fix:{label, href} } } }
export interface MwaaMissingItem {
  targetId: string;
  region: string;
  displayName?: string;
  reason: string;
}
export interface MwaaMissingPayload {
  message: string;
  missing: MwaaMissingItem[];
  fix: { label: string; href: string };
}

export const MWAA_NOT_INSTALLED = "MWAA_NOT_INSTALLED";
// (SPEC v3.27 §2.1):新码;旧码保留一版,两个都认
export const SCHEDULER_NOT_INSTALLED = "SCHEDULER_NOT_INSTALLED";
export const SCHEDULER_MISSING_CODES: readonly string[] = [SCHEDULER_NOT_INSTALLED, MWAA_NOT_INSTALLED];

/** 从 fetch 回来的 JSON 里取「缺 MWAA」载荷;不是该错误 ⇒ null。形状不对(旧后端)⇒ null(前端照旧走通用错误提示)。 */
export function extractMwaaMissing(body: unknown): MwaaMissingPayload | null {
  const err = (body as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
  if (!err || !SCHEDULER_MISSING_CODES.includes(String(err.code))) return null;
  const detail = (err.detail ?? {}) as { missing?: unknown; fix?: unknown };
  const missing = Array.isArray(detail.missing)
    ? (detail.missing as unknown[])
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => ({
          targetId: String(m.targetId ?? ""),
          region: String(m.region ?? "?"),
          displayName: typeof m.displayName === "string" ? m.displayName : undefined,
          reason: String(m.reason ?? ""),
        }))
        .filter((m) => m.targetId)
    : [];
  const fix = (detail.fix ?? {}) as { label?: unknown; href?: unknown };
  return {
    message: String(err.message ?? ""),
    missing,
    fix: {
      label: typeof fix.label === "string" && fix.label ? fix.label : "去执行环境补装调度",
      href: typeof fix.href === "string" && fix.href.startsWith("/") ? fix.href : `/exec-envs?target=${encodeURIComponent(missing[0]?.targetId ?? "")}&highlight=airflow-serverless`,
    },
  };
}

/** 下发预览行(`rows[].code === MWAA_NOT_INSTALLED`)也能拼出同一份载荷 —— 预览与发布失败两处用同一张卡。 */
export function mwaaMissingFromPreviewRows(rows: unknown): MwaaMissingPayload | null {
  if (!Array.isArray(rows)) return null;
  const missing: MwaaMissingItem[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r && SCHEDULER_MISSING_CODES.includes(String(r.code))) {
      missing.push({ targetId: String(r.targetId ?? ""), region: String(r.region ?? "?"), reason: String(r.reason ?? "未安装调度组件") });
    }
  }
  if (missing.length === 0) return null;
  return {
    message: "",
    missing,
    // 默认高亮 serverless(INTERACTION v2.19 §2.2a)
    fix: { label: "去执行环境补装调度", href: `/exec-envs?target=${encodeURIComponent(missing[0].targetId)}&highlight=airflow-serverless` },
  };
}
