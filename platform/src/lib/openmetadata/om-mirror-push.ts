// @kf-batch 50-WP2-one-agentcore-one-om
// **元数据镜像 → OpenMetadata**:让「一个 OM」真的能回答「某个区有哪些表」。
//
// 🔴🔴 **用户 2026-09-10 拍板(逐字)**:「治理目录必须走同一个 OpenMetaData,不然又多维护一套东西,
//    到时候极其容易出现不兼容和忘记修复的情况。」
//
// 于是链路定成一条:
//   **每个区的 Glue / 数仓目录 →(W3-e 既有的镜像采集)→ 本模块推进 OM 的 per-target service → 目录页只读 OM**
// 目录页因此**只有一条呈现路径**(OM),而「哪个区」是 OM 里的 service 维度(见 `om-service.ts`)。
//
// ── 三条边界(都是踩过的坑,不是洁癖)────────────────────────────────────────
// ① **OM 写入原语只有一份**:service / database / schema / table 四个 PUT 全部复用 `om-push.ts` 的导出,
//    不在这里另写 HTTP 调用 —— 那里的 `putTable` 含一条**承重**逻辑(空列时不许用 `_row` 覆盖真实列,
//    否则列级血缘全局消失),另写一份必然漏掉它。
// ② **本模块不决定「采什么」**:它只翻译镜像已经采到的东西。采集口径(哪些来源、多久一次、
//    数仓只手动)归 W3-e 的 §3.13,别在这里加第二套判断。
// ③ **失败要报,不许静默**:推不进 OM = 目录页那个区会**停在上一次的样子**,而页面上看不出来。
//    ⇒ 返回计数与错误,由调用方(镜像)记进结果,让管理面能显示。

import { isHome } from "@/lib/exec-env/target-id";
import { omServiceFor, type OmMirrorSource } from "@/lib/openmetadata/om-service";
// 🔴 从**轻量层**拿原语,绝不从 `om-push` 拿:后者 import 了 genbi/athena,那条链最终走到
//    `node:crypto`,而本模块被周期任务(instrumentation / edge 面)可达 ⇒ 会让 `next build` 直接失败。
//    门禁 `instrumentation-bundle-guard` 会当场逮住(它已经逮过一次,就是这一处)。
import { ensureService, customDbService, putDatabase, putSchema, putTable } from "@/lib/openmetadata/om-write";
import { isOmConfigured } from "@/lib/openmetadata/om-client";

/** 一轮最多推多少张表。镜像本身上限 2000;OM 的 PUT 是逐个 HTTP ⇒ 给个更小的上限并**如实报告截断**。 */
export const OM_MIRROR_MAX_TABLES = 800;

export interface OmMirrorPushResult {
  /** 真正 upsert 成功的表数 */
  tables: number;
  /** 建/确认的 service 名(便于排障时一眼看出落在哪个区的服务上) */
  services: string[];
  /** 触到上限被截断(⇒ 该区目录在 OM 里不完整,必须让人看见) */
  truncated: boolean;
  /** 失败的那些(表 fqn → 错误);非空 = 目录页那个区会停在旧样子 */
  errors: Array<{ fqn: string; error: string }>;
}

interface MirrorEntryLike {
  kind: string;
  fqn: string;
  payload: Record<string, unknown>;
}

/** `redshift.<db>.<schema>.<table>` / `glue.<db>.<table>` → OM 的四段坐标。🔴 推送与对账(om-reconcile)共用这一个作者。 */
export function omCoordsOf(fqn: string): { source: OmMirrorSource; database: string; schema: string; table: string } | null {
  const parts = fqn.split(".");
  const head = parts[0];
  if (head === "redshift" && parts.length === 4) {
    return { source: "redshift", database: parts[1], schema: parts[2], table: parts[3] };
  }
  if (head === "glue" && parts.length === 3) {
    // Glue 没有 schema 这一层 ⇒ 统一放到 `default`(与 om-push 里数据源侧的既有约定一致)
    return { source: "glue", database: parts[1], schema: "default", table: parts[2] };
  }
  return null;
}

function columnsOf(payload: Record<string, unknown>): Array<{ name: string; type?: string }> {
  const raw = payload?.columns;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      const o = (c ?? {}) as { name?: unknown; type?: unknown };
      return { name: String(o.name ?? ""), ...(o.type ? { type: String(o.type) } : {}) };
    })
    .filter((c) => c.name.length > 0);
}

/**
 * 把一轮镜像采到的条目推进 OM。
 *
 * 🔴 **只处理 `kind === "table"`**:库/schema 由表的坐标顺带 ensure(OM 要求父实体先在),
 * 而镜像的 `db` 条目只是给总览数数用的,没有额外信息。
 * 🔴 本函数**只推不删**;「本轮没看见的表」由 `om-reconcile.ts` 在采集**确知完整**时软删
 *   (B-42 根治:原来这里写「留到 OM 侧清理」,而 OM 侧根本没有清理者 ⇒ 删掉的表永远留在目录里)。
 */
export async function pushMirrorToOpenMetadata(args: {
  targetId: string;
  entries: readonly MirrorEntryLike[];
}): Promise<OmMirrorPushResult> {
  const out: OmMirrorPushResult = { tables: 0, services: [], truncated: false, errors: [] };
  // OM 没配 ⇒ 什么都不做(目录页会走它自己的「OM 不可达」兜底);不抛,不假装推成功了。
  if (!isOmConfigured()) return out;

  const tables = args.entries.filter((e) => e.kind === "table");
  const use = tables.slice(0, OM_MIRROR_MAX_TABLES);
  out.truncated = tables.length > use.length;

  const ensuredService = new Set<string>();
  const ensuredDb = new Set<string>();
  const ensuredSchema = new Set<string>();

  for (const e of use) {
    const c = omCoordsOf(e.fqn);
    if (!c) continue;
    const service = omServiceFor(c.source, args.targetId);
    try {
      if (!ensuredService.has(service)) {
        await ensureService(service, customDbService(service));
        ensuredService.add(service);
        out.services.push(service);
      }
      const dbKey = `${service}.${c.database}`;
      if (!ensuredDb.has(dbKey)) {
        await putDatabase(c.database, service);
        ensuredDb.add(dbKey);
      }
      const schemaKey = `${dbKey}.${c.schema}`;
      if (!ensuredSchema.has(schemaKey)) {
        await putSchema(c.schema, dbKey);
        ensuredSchema.add(schemaKey);
      }
      await putTable(c.table, schemaKey, columnsOf(e.payload));
      out.tables += 1;
    } catch (err) {
      out.errors.push({ fqn: e.fqn, error: (err as Error)?.message ?? String(err) });
      // 单表失败不打断整轮:一张畸形表名不该让整个区的目录都推不上去
      if (out.errors.length > 20) break;
    }
  }
  // 🔴 主控区也走同一条路(service 名不带后缀)⇒ 「一个 OM」这句话对所有区都成立,
  //    而不是「主控区靠别的推送、其它区靠镜像」——那又是两套。
  void isHome;
  return out;
}
