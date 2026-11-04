export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetTablesCommand, GetDatabasesCommand } from "@aws-sdk/client-glue";
import { omRequest, isOmConfigured } from "@/lib/openmetadata/om-client";
import { apiOk } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth/verify-token";
import { listAllClassifications, strongerLevel } from "@/lib/governance/classification";
// @kf-batch 50-WP2-one-agentcore-one-om
// 🔴🔴 **用户 2026-09-10 拍板:「治理目录必须走同一个 OpenMetaData,不然又多维护一套东西,
//    到时候极其容易出现不兼容和忘记修复的情况。」**
// ⇒ 目录**只有一条呈现路径 = OM**;「哪个区」是 OM 里的 **per-target service** 维度(`om-service.ts`),
//   各区的表由**元数据镜像**(W3-e 的 per-region 采集)推进 OM(`om-mirror-push.ts`)。
// ⇒ 上一版给非主控区开的「直查那个区 Glue + 数仓」那条第二路径**已删除**。
//   代价如实说明:目录反映的是**镜像同步时刻**的样子(不是实时)⇒ 响应带该区的 `freshness`,
//   页面必须把「同步于何时 / 需不需要手动刷」显示出来(W3-e 早就定了五态,别再造第二套说法)。
import {
  directQueryRaw,
  resolveDirectQueryPlaceSafe,
  noWarehouseMeta,
  type DirectQueryScope,
} from "@/lib/redshift/direct-query";
import { glueClientFor } from "@/lib/exec-env/target-clients";
import { requireScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { getActiveProjectId } from "@/lib/projects/guard";
import { omServiceBase, omServiceTargetOf } from "@/lib/openmetadata/om-service";
import { listScopeTargets } from "@/lib/exec-env/data-plane-target";
import { buildMirrorOverview } from "@/lib/exec-env/metadata-mirror";

// ─────────────────────────────────────────────────────────────────────────────
// P4: OpenMetadata is the system-of-record for the data catalog.
// We list tables from OM (covers source / S3 Tables / Redshift / Glue ingested by
// the connectors + event-driven push). The legacy direct query (Glue Data Catalog
// + Redshift) is kept ONLY as a fallback for when OM is unconfigured/unreachable so
// the page never goes blank during an OM outage.
// ─────────────────────────────────────────────────────────────────────────────

// Map an OM service name -> { type (frontend icon key), source (tag label), format }.
// FQNs are <service>.<db>.<schema>.<table>; the service prefix identifies the system.
function describeService(service?: string, serviceType?: string): { type: string; source: string; format: string } {
  // @kf-batch 50-WP2-one-agentcore-one-om —— per-target service 名带 `-<targetSlug>` 后缀:
  // 图标与来源标签按**去后缀**的基名判(否则每加一个区,目录里那些行的图标全退化成默认值)。
  // @kf-batch 50-o4REG-sync-om-per-target —— 去后缀收成单一作者 `omServiceBase`(五类 service 一起认;
  //   原来这里只认 redshift / glue,同步推进非主控区的 `bgp-s3tables-<slug>` / `bgp-sources-<slug>` 会退化成默认图标)。
  const base = omServiceBase(service || "");
  switch (base) {
    case "bgp-redshift": return { type: "redshift", source: "Redshift", format: "Table" };
    case "bgp-s3tables": return { type: "s3", source: "S3 Tables", format: "Iceberg" };
    case "bgp-s3": return { type: "s3", source: "S3", format: "Container" };
    case "bgp-glue": return { type: "glue", source: "Glue", format: "Parquet" };
    case "bgp-sources": return { type: "mysql", source: "数据源", format: "MySQL" };
    default: {
      const st = (serviceType || "").toLowerCase();
      const type = st.includes("redshift") ? "redshift"
        : st.includes("postgres") ? "postgresql"
        : st.includes("mysql") ? "mysql"
        : st.includes("glue") ? "glue"
        : st.includes("s3") || st.includes("storage") ? "s3"
        : "";
      return { type, source: serviceType || service || "OpenMetadata", format: serviceType || "Table" };
    }
  }
}

// Convert an OM Table entity (from /api/v1/tables) into the catalog row shape the
// frontend already understands. `type` is added (icon hint); all prior fields kept.
function toRow(t: any, knownTargetIds: readonly string[] = []) {
  const service: string | undefined = t?.service?.name || t?.fullyQualifiedName?.split(".")[0];
  const d = describeService(service, t?.serviceType);
  const db: string | undefined = t?.database?.name;
  const schema: string | undefined = t?.databaseSchema?.name;
  return {
    fqn: t?.fullyQualifiedName,
    name: t?.name,
    type: d.type,
    source: d.source,
    database: schema ? `${db}.${schema}` : db,
    format: d.format,
    columns: Array.isArray(t?.columns) ? t.columns.length : 0,
    updatedAt: t?.updatedAt ? new Date(t.updatedAt).toISOString() : null,
    // @kf-batch 50-WP2-one-agentcore-one-om —— 这张表属于哪个执行环境(service 后缀判;无后缀 = 主控区)。
    // 加这个字段是为了让「全部」视角也能一眼看出跨区归属,而不是只能靠切区来分辨。
    targetId: service ? omServiceTargetOf(service, knownTargetIds) : undefined,
  };
}

// List all tables from OM (paged). Returns null on the first-call error so the caller
// can fall back to the legacy direct query; returns an array (possibly empty) otherwise.
async function listOmTables(): Promise<any[] | null> {
  const out: any[] = [];
  let after = "";
  for (let i = 0; i < 10; i++) {
    const qs = `limit=200&fields=columns&include=non-deleted${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const page = await omRequest("GET", `/api/v1/tables?${qs}`);
    if (!page) return i === 0 ? null : out; // hard failure on first page -> signal fallback
    const data: any[] = page.data || [];
    out.push(...data);
    after = page.paging?.after || "";
    if (!after || data.length === 0) break;
  }
  return out;
}

// Legacy fallback: direct query of Glue Data Catalog + Redshift (pre-OM behavior).
async function fromDirectQuery(keyword: string, scope: DirectQueryScope): Promise<any[] | { capability: "unavailable"; targetId: string; missing: "redshift"; reason: string }> {
  // @kf-batch 50-WP2-directquery —— 落点先解析:「该区没装数仓」⇒ 能力态(Glue 那半边也不再单独列,
  // 因为页面此时整块降级;真要只看数据湖是 Athena 那条路,属另一个包)。
  const pre = await resolveDirectQueryPlaceSafe(scope);
  if (pre.capability === "unavailable") return pre;
  const place = pre.place;
  const glue = await glueClientFor(place.region);
  const catalog: any[] = [];

  // 1. Glue Data Catalog
  try {
    const { DatabaseList = [] } = await glue.send(new GetDatabasesCommand({}));
    for (const db of DatabaseList.slice(0, 5)) {
      try {
        const { TableList = [] } = await glue.send(new GetTablesCommand({ DatabaseName: db.Name }));
        for (const t of TableList) {
          if (!keyword || t.Name?.includes(keyword) || db.Name?.includes(keyword)) {
            catalog.push({
              fqn: `glue.${db.Name}.${t.Name}`,
              name: t.Name, type: "glue", database: db.Name, source: "Glue Data Catalog",
              columns: t.StorageDescriptor?.Columns?.length || 0,
              location: t.StorageDescriptor?.Location,
              format: t.StorageDescriptor?.InputFormat?.includes("parquet") ? "Parquet" : t.StorageDescriptor?.InputFormat?.includes("orc") ? "ORC" : "Other",
              updatedAt: t.UpdateTime?.toISOString(),
            });
          }
        }
      } catch {}
    }
  } catch {}

  // 2. Redshift tables
  try {
    // 🔴 轮询预算保持**该站点原值 15 × 1000ms**(别处 50×700 / 40×600);
    //    错误一律吞掉也是原状(目录页宁可少列几行也不整页报错)。
    const raw = await directQueryRaw(
      place,
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('information_schema','pg_catalog','pg_internal','pg_automv')",
      { rounds: 15, intervalMs: 1000 }
    );
    for (const row of raw.records) {
      const cells = row as unknown as Array<Record<string, unknown>>;
      const schema = String(Object.values(cells[0])[0]);
      const table = String(Object.values(cells[1])[0]);
      if (!keyword || table.includes(keyword) || schema.includes(keyword)) {
        catalog.push({
          fqn: `redshift.${place.database}.${schema}.${table}`,
          name: table, type: "redshift", database: `${place.database}.${schema}`, source: "Redshift",
          format: "Table", updatedAt: null,
        });
      }
    }
  } catch {}

  return catalog;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const keyword = (req.nextUrl.searchParams.get("keyword") || "").trim();
  // @kf-batch 50-WP2-directquery —— 执行范围(读路由 ⇒ 只认 URL 的 `?scope=`)
  const scope = await requireScope(req, getActiveProjectId(req));
  if (scope instanceof NextResponse) return scope;
  const picked = scopeTargets(scope);
  // 🔴 **非 home 视角不走 OpenMetadata**:OM 是**中央单实例、只 ingest 主控区**(W3-e 实测结论),
  const single = picked.length === 1 ? picked[0] : undefined;

  // @kf-batch 50-WP2-one-agentcore-one-om
  // **Primary(而且是唯一的呈现路径):OpenMetadata**。
  // 视角过滤 = 按 OM 的 service 归属(`bgp-*-<targetSlug>` 属那个区;无后缀属主控区)。
  if (isOmConfigured()) {
    const tables = await listOmTables();
    if (tables) { // non-null => OM reachable; trust it (even if empty)
      // 已装好的执行环境清单 —— 用来判 service 后缀属于谁。
      // 🔴 用「装好了吗」而不是「此刻能不能承接」(阶段 1 的 N-9 教训:呈现面不许用可服务性当判据)。
      // 🔴 一次取全,`known` 与「这个 target 装了数仓吗」都从它派生 —— **零额外 I/O**
      //    (E-140b 的修法不许为了一句提示再多打一次注册表)。
      // @kf-batch 50-WP11b-shared-writer —— scope 必填:与顶栏下拉(exec-targets)同一个口径 = 当前项目
      //   (原来不传 ⇒ 无项目上下文 ⇒ 白名单区的 service 后缀认不出,行被归到主控区)。
      const knownTargets = await listScopeTargets({ scope: "per-project", projectId: getActiveProjectId(req) }).catch(() => [] as Awaited<ReturnType<typeof listScopeTargets>>);
      const known = knownTargets.map((t) => t.targetId);
      const kw = keyword.toLowerCase();
      const rows = tables
        .map((t) => toRow(t, known))
        // 🔴 视角过滤:target 视角只留属于它的 service;「全部」不过滤(与改动前逐字节一致)
        .filter((r) => !single || r.targetId === single)
        .filter((r) =>
          !kw ||
          r.name?.toLowerCase().includes(kw) ||
          r.fqn?.toLowerCase().includes(kw) ||
          r.database?.toLowerCase().includes(kw)
        )
        .sort((a, b) => (a.fqn || "").localeCompare(b.fqn || ""));
      // 模块 18: annotate each row with its strongest sensitivity level (for the catalog tag).
      const cls = await listAllClassifications().catch(() => []);
      const levelByFqn = new Map<string, string | undefined>();
      for (const c of cls) levelByFqn.set(c.fqn, strongerLevel(levelByFqn.get(c.fqn), c.level));
      const annotated = rows.map((r) => ({ ...r, sensitivity: levelByFqn.get(r.fqn) || null }));
      // 🔴 **新鲜度必须一起回**:OM 里那个区的表来自**镜像同步**,不是实时直查。
      //    不回 = 用户看到一张目录却不知道它是什么时候的(W3-e 定的五态就是为这件事)。
      //    只在 target 视角回(全部视角是多区混排,单一时间戳会说谎)。
      let freshness: Record<string, unknown> | undefined;
      if (single) {
        try {
          const ov = await buildMirrorOverview();
          const f = ov.facets.find((x) => x.targetId === single);
          if (f) {
            freshness = {
              targetId: f.targetId,
              region: f.region,
              state: f.state,
              mirroredAt: f.mirroredAt ?? null,
              tables: f.tables,
              truncated: f.truncated,
              warehouse: f.warehouse ? { state: f.warehouse.state, at: f.warehouse.at ?? null } : null,
            };
          }
        } catch {
          // 读不到新鲜度**不影响目录**,但也不编一个「刚刚同步」——缺就是缺(页面按 undefined 处理)
        }
      }
      // @kf-batch 50-E140b-catalog-no-warehouse
      // 🔴 **该 target 没装数仓 ⇒ 必须说出来**(2026-09-12 写 E-140 判据时挖出的缺口)。
      //   背景:用户 2026-09-10 拍板「目录都走同一个 OpenMetadata」之后,本路由不再走直查
      //   ⇒ 直查那条路上的 `capability:"unavailable"` **走不到** ⇒ 页面横幅不会出现
      //   ⇒ core-only 目标的目录是一张**不给原因的空表**,用户会以为同步坏了 / 表丢了。
      //   平台自己的规矩是「读不到就说读不到」(§2.6 护栏一「不丢东西」的同一条),所以这里补一句。
      // 🔴 走 `_meta` 而**不改 `data` 形状**:目录数据仍是数组,消费者(页面表格、E-137/E-139 判据)
      //   一个字节都不用改;拒因文案复用 `NO_WAREHOUSE_REASON` **单一作者**,与直查那条路逐字一致
      //   —— 两处各写一份措辞,用户就会看到「同一件事两种说法」。
      const warehouse = noWarehouseMeta(single ? knownTargets.find((x) => x.targetId === single) : undefined);
      const meta = { ...(freshness ? { catalogFreshness: freshness } : {}), ...(warehouse ? { warehouse } : {}) };
      return apiOk(annotated, 200, Object.keys(meta).length ? meta : undefined);
    }
  }

  // Fallback: 仅当 **OM 未配置 / 不可达** 时的兜底(legacy 直查,主控区那套)——
  // 🔴 它**不是**「非 home 的第二条路」(那条已按用户拍板删除),只是 OM 停机时页面不至于全白。
  // @kf-batch 50-WP31-place-first-class —— 落点显式:单区视角 = 该区;「全部 / 对比」视角的兜底 = 主控区那套(本分支只为 OM 停机时页面不全白)
  return apiOk(await fromDirectQuery(keyword, { targetId: single ?? HOME_TARGET_ID, projectId: getActiveProjectId(req) }));
}
