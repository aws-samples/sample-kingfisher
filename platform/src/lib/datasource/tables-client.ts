// 序 38 B-70 —— 前端取「数据源的表清单」的唯一作者(数据源页「浏览表」与同步向导第二步都用它)。
//   `GET /api/datasources/<id>/tables` 有三种应答:
//   · 200 数组               = 控制面直连读到(存量语义);
//   · 202 { discovering }    = 直连不到 / 源在自有网络 ⇒ 已起经 Glue 连接的发现作业,要轮询;
//   · 200 { tables, via }    = 发现作业的结果(缓存在源行;refresh=1 才重新发现)。
"use client";

export interface SourceTableInfo { name: string; database?: string; columns?: Array<{ name: string; type: string; nullable?: boolean; key?: string; comment?: string }> }
export interface TablesFetchResult {
  tables: SourceTableInfo[];
  via: "control-plane" | "glue-discovery";
  note?: string;
  discoveredAt?: string;
}
export interface TablesFetchOptions {
  refresh?: boolean;
  /** 第一次拿到 202 时回调一次(页面提示「正在经 Glue 连接发现…」)。 */
  onWaiting?: (info: { note?: string; startedAt?: string }) => void;
  pollMs?: number;
  maxPolls?: number;
  fetchImpl?: typeof fetch;
}

export const TABLES_POLL_DEFAULTS = { pollMs: 10_000, maxPolls: 36 } as const; // ≈ 6 分钟

export async function fetchSourceTables(datasourceId: string, database: string | undefined, opts: TablesFetchOptions = {}): Promise<TablesFetchResult> {
  const f = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? TABLES_POLL_DEFAULTS.pollMs;
  const maxPolls = opts.maxPolls ?? TABLES_POLL_DEFAULTS.maxPolls;
  const qs = new URLSearchParams();
  if (database) qs.set("database", database);
  if (opts.refresh) qs.set("refresh", "1");
  let waited = false;
  for (let i = 0; i <= maxPolls; i++) {
    const url = `/api/datasources/${encodeURIComponent(datasourceId)}/tables${qs.toString() ? `?${qs.toString()}` : ""}`;
    const res = await f(url);
    const json: any = await res.json().catch(() => ({}));
    const body = json && typeof json === "object" && "success" in json && json.success && json.data !== undefined ? json.data : json;
    if (res.status === 202 && body?.discovering) {
      if (!waited) { waited = true; opts.onWaiting?.({ note: body.note, startedAt: body.startedAt }); }
      // 第一次 202 之后不再带 refresh(否则每次轮询都像在要求重新发现)
      qs.delete("refresh");
      if (i === maxPolls) throw new Error(body.note ? `${body.note} —— 等待超时,请稍后再点「浏览表」` : "发现表等待超时");
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (!res.ok || body?.error) {
      const msg = typeof body?.error === "string" ? body.error : body?.error?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    if (Array.isArray(body)) return { tables: body, via: "control-plane" };
    if (Array.isArray(body?.tables)) return { tables: body.tables, via: body.via === "glue-discovery" ? "glue-discovery" : "control-plane", note: body.note, discoveredAt: body.discoveredAt };
    return { tables: [], via: "control-plane" };
  }
  throw new Error("发现表等待超时");
}
