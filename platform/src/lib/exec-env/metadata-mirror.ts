// 跨地域**只读元数据镜像**的服务端(50 SPEC §3.13 / §1.1 新表 / INTERACTION §4quater)。
//
// ── 这一刀在做什么 ──────────────────────────────────────────────────────────
// AWS **没有跨 region 的全局数据目录**(Glue Catalog 是 region 内的、RAM 不跨区),所以
// 「一屏看全部 target 的资产」只能自建镜像:中央按 target 去**它自己的 region** 拉元数据,
// 落 `bgp-metadata-mirror`,页面读镜像。对标产品(含 DataWorks)只能切在单地域看 ⇒ 这是差异化点。
//
// 🔴 本文件最要紧的四条,每条都对应一个"看起来正常"的坑:
//  ① **只搬元数据,零数据 egress**:出口只经 `sanitize*` 三个函数**重建**对象 ——
//     不是"过滤掉危险字段",是**只有白名单字段能进去**(禁止列表在承重面永远漏,
//     `RECONCILE_ALLOWED_FIELDS` / `assertProjectId` 已经教过两次)。抽样值、行数据一个都进不来。
//  ② **陈旧必须能看见**:镜像是最终一致的,页面上一定要写 `mirroredAt`;
//     绝不用旧镜像假装实时(判定在 `metadata-mirror-shared.mirrorFacetState`,单一作者)。
//  ③ **部分失败不许被总数吞掉**:一个来源挂了就在那个来源上记 error,
//     而不是让分面显示"资产 0"(0 在界面上等于"这个区很干净",比报错危险得多)。
//  ④ **删掉的表要消失**:同一来源的这一轮没看见的条目**当场删**,不等 7d TTL ——
//     否则"那个区的表早删了、总览里还挂着"就是一个反向假绿。
//     🔴 只删**本轮真采过的来源**的条目:glue-only 的定时刷新绝不能把手动采的数仓目录抹掉。

import { QueryCommand, BatchWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { isHome, HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { glueClientFor } from "@/lib/exec-env/target-clients";
// 🔴 **只依赖轻量层**:`data-plane-target` 会经 privileged-cred → project-schema 用到 `crypto`,
//    而本文件被周期 reconciler(instrumentation)引用 ⇒ 那条 edge 编译**没有 node 内置模块**,
//    引用一下 `next build` 就失败(真部署吃过一次;动态 import 也救不了,见 target-region.ts 文件头)。
import { regionOfTarget } from "@/lib/exec-env/target-region";
import type { OmReconcileResult } from "@/lib/openmetadata/om-reconcile";
import {
  MIRROR_FACET_SK,
  MIRROR_TTL_MS,
  MIRROR_TIMER_SOURCES,
  NOT_COLLECTED,
  mirrorFacetState,
  mirrorPk,
  mirrorSk,
  parseMirrorSk,
  type MirrorFacet,
  type MirrorKind,
  type MirrorOverview,
  type MirrorSource,
  type MirrorSourceReport,
} from "@/lib/exec-env/metadata-mirror-shared";

/**
 * 分面索引放**独立分区** `mirror#__facets`(sk = targetId)。
 *
 * 🔴 为什么不把分面塞进 `mirror#<targetId>`:一屏总览要"所有 target 的分面",
 * 而按 target 分区就只能 **Scan 整张表**才能发现"有镜像但已不活跃"的 target ——
 * Scan 的 FilterExpression 在**读之后**才生效,等于每次开页面都把几千条表条目读一遍(还要计费)。
 * 独立分区一次 Query 就拿全,且天然满足「活跃 ∪ 出现过」这条列的取法(与一致性矩阵同纪律)。
 * 撞不上真 target:`targetId` 必须匹配 `^tgt_…$`,而 `__facets` 不是合法 targetId。
 */
const FACET_PK = "mirror#__facets";

/** 单个 target 的条目上限(超了就截断,但 🔴 **必须**在分面上说出来)。 */
export const MIRROR_MAX_ENTRIES = 2000;
/** 每个来源翻页上限(防一个畸形目录把 tick 拖死)。 */
const MAX_PAGES = 20;
/** 单表列名上限:一张 1000 列的表会把 item 顶到 400KB 上限 ⇒ 截断并标注。 */
const MAX_COLUMNS_PER_TABLE = 200;

// ── 出口对象:**只有这三个函数**能构造进库的 payload ──────────────────────────

/** 库条目 payload(白名单重建;`source` 冗余存一份便于排障,但删条目仍按 fqn 前缀判) */
export function sanitizeDbPayload(raw: { name: string; source: MirrorSource; tables?: number }) {
  return {
    name: String(raw.name).slice(0, 300),
    source: raw.source,
    ...(typeof raw.tables === "number" ? { tables: raw.tables } : {}),
  };
}

/**
 * 表条目 payload。🔴 **列只存名字与类型** —— 没有任何字段能承载行数据/抽样值,
 * 因为这个对象是**新建**的,调用方传进来的多余字段连不进来(与 `sanitize` 的语义差别就在这)。
 */
export function sanitizeTablePayload(raw: {
  name: string;
  db: string;
  source: MirrorSource;
  tableType?: string;
  columns?: Array<{ name?: string; type?: string }>;
}) {
  const cols = Array.isArray(raw.columns) ? raw.columns : [];
  const kept = cols.slice(0, MAX_COLUMNS_PER_TABLE).map((c) => ({
    name: String(c?.name ?? "").slice(0, 200),
    type: String(c?.type ?? "").slice(0, 100),
  }));
  return {
    name: String(raw.name).slice(0, 300),
    db: String(raw.db).slice(0, 300),
    source: raw.source,
    ...(raw.tableType ? { tableType: String(raw.tableType).slice(0, 60) } : {}),
    columnCount: cols.length,
    columns: kept,
    // 🔴 静默截断 = 「这张表就 200 列」的假象 ⇒ 明写
    ...(cols.length > kept.length ? { columnsTruncated: true } : {}),
  };
}

interface PulledEntry {
  kind: MirrorKind;
  fqn: string;
  payload: Record<string, unknown>;
}

// ── 来源一:该 target region 的 Glue Data Catalog(免费目录 API,定时可刷)──────

async function pullGlueCatalog(region: string): Promise<MirrorPullOutcome> {
  const {
    GetDatabasesCommand,
    GetTablesCommand,
  } = await import("@aws-sdk/client-glue");
  const glue = await glueClientFor(region);

  const entries: PulledEntry[] = [];
  let databases = 0;
  let tables = 0;
  let columns = 0;
  let truncated = false;

  const dbNames: string[] = [];
  const unreadDatabases: string[] = [];
  let dbToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await glue.send(new GetDatabasesCommand({ MaxResults: 100, ...(dbToken ? { NextToken: dbToken } : {}) }));
    for (const d of r.DatabaseList ?? []) if (d.Name) dbNames.push(d.Name);
    dbToken = r.NextToken;
    if (!dbToken) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  for (const db of dbNames) {
    if (entries.length >= MIRROR_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    // 🔴 一个库读不到**不掀翻整次采集**(常见:LakeFormation 只授了部分库)——
    //    记进 payload 的 tables=0 会撒谎,所以宁可让这个库缺席、由 truncated/error 侧说话。
    let dbTables = 0;
    try {
      let tToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await glue.send(
          new GetTablesCommand({ DatabaseName: db, MaxResults: 100, ...(tToken ? { NextToken: tToken } : {}) })
        );
        for (const t of r.TableList ?? []) {
          if (!t.Name) continue;
          if (entries.length >= MIRROR_MAX_ENTRIES) {
            truncated = true;
            break;
          }
          const cols = (t.StorageDescriptor?.Columns ?? []).map((c) => ({ name: c.Name, type: c.Type }));
          entries.push({
            kind: "table",
            fqn: `glue.${db}.${t.Name}`,
            payload: sanitizeTablePayload({
              name: t.Name,
              db,
              source: "glue",
              tableType: t.TableType,
              columns: cols,
            }),
          });
          dbTables++;
          tables++;
          columns += cols.length;
        }
        tToken = r.NextToken;
        if (!tToken) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
    } catch (e) {
      // 单库失败:记录到日志,继续下一个库;🔴 并**如实报出**:不报 = 这个库被当成「本轮没有表」
      //   ⇒ 镜像差集与 OM 对账会把它整库删掉。
      console.warn("[mirror] GetTables(%s/%s) 失败:%s", region, db, String((e as Error)?.message ?? e));
      unreadDatabases.push(db);
    }
    entries.push({
      kind: "db",
      fqn: `glue.${db}`,
      payload: sanitizeDbPayload({ name: db, source: "glue", tables: dbTables }),
    });
    databases++;
  }

  return { entries, databases, tables, columns, truncated, unreadDatabases };
}

// ── 来源二:该 target 的 Redshift 数仓目录 ────────────────────────────────────
// 🔴 **不在本文件里**:它经 `data-plane-target` → `privileged-cred` → `project-schema` 会用到
// `crypto`,而本文件被周期 reconciler(instrumentation)引用 ⇒ edge 编译期直接炸(真部署吃过一次)。
// 而且它按 §3.9b **必须带 projectId**,定时循环里压根没有。
// ⇒ 实现在 `metadata-mirror-warehouse.ts`,由**路由**(有请求上下文的一侧)注入进 `mirrorMetadata`。
//   于是「定时把每个区的 Serverless 数仓唤醒」在**类型层**就不可能发生。

/** 一次采集的产出(给注入进来的 puller 用同一个形状)。 */
export interface MirrorPullOutcome {
  entries: PulledEntry[];
  databases: number;
  tables: number;
  columns: number;
  truncated: boolean;
  /**
   * 🔴 本轮**读失败**的库(如 LakeFormation 只授了部分库)。
   * 必填、不给默认值 —— 采集器漏报 = 那个库被当成「一张表都没有」⇒ 镜像差集与 OM 对账会把它整库删掉。
   */
  unreadDatabases: string[];
}

/** 注入式采集器:`(targetId) => 产出`。目前只有数仓目录走这条(Glue 内建)。 */
export type MirrorSourcePuller = (targetId: string) => Promise<MirrorPullOutcome>;

// ── 写入:upsert 本轮看见的 + 删除本轮同来源没看见的 ─────────────────────────

/** fqn 的第一段就是来源(写入时会断言,读侧删条目只按它判 ⇒ 两者不可能不一致)。 */
function sourceOfFqn(fqn: string): MirrorSource | null {
  const head = fqn.split(".")[0];
  return head === "glue" || head === "redshift" ? head : null;
}

function assertFqnMatchesSource(fqn: string, source: MirrorSource): void {
  if (sourceOfFqn(fqn) !== source) {
    // 结构性不变量:删除逻辑靠前缀判来源,前缀错了就会删错来源的条目(静默丢半张总览)
    throw new Error(`镜像条目 fqn=${fqn} 的来源前缀与 source=${source} 不一致 ⇒ 拒绝写入`);
  }
}

async function chunkedWrite(requests: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    const chunk = requests.slice(i, i + 25);
    let unprocessed = { [TABLES.METADATA_MIRROR]: chunk } as Record<string, unknown[]>;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await docClient.send(new BatchWriteCommand({ RequestItems: unprocessed as never }));
      const left = (r.UnprocessedItems ?? {}) as Record<string, unknown[]>;
      const n = (left[TABLES.METADATA_MIRROR] ?? []).length;
      if (!n) break;
      // 🔴 未处理项**必须重试**:BatchWrite 部分成功是正常返回(不是异常),
      //    不重试就会静默少写几十条 ⇒ 分面上表现为"这个区的表少了几张"。
      unprocessed = left;
      await new Promise((r2) => setTimeout(r2, 100 * (attempt + 1)));
      if (attempt === 4) throw new Error(`镜像写入有 ${n} 条始终未处理 ⇒ 本轮判失败(不当成功)`);
    }
  }
}

/** 列出该 target 现有条目的 sk(只投影键,便于算"本轮没看见的")。 */
async function listExistingSks(targetId: string): Promise<string[]> {
  const out: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 40; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.METADATA_MIRROR,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": mirrorPk(targetId) },
        ProjectionExpression: "sk",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of (r.Items ?? []) as Array<{ sk?: string }>) if (it.sk) out.push(it.sk);
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  return out;
}

export interface MirrorRunResult {
  /**
   * 本轮推进 OpenMetadata 的结果(目录页只读 OM ⇒ 推不进去就等于那个区的目录停更,必须能看见)。
   * `errors: -1` = 整体推送抛异常(见 `error`)。
   */
  om?: {
    tables: number;
    services: string[];
    truncated: boolean;
    errors: number;
    error?: string;
    /** 🔴 本轮对 OM 的对账(每个采成功的来源一份;`skipped` 有值 = 这一轮没删并说明为什么) */
    reconcile?: OmReconcileResult[];
  };
  targetId: string;
  facet: MirrorFacet;
  /** 本轮实际采了哪些来源(定时 = 只有 glue) */
  sources: MirrorSource[];
}

/**
 * 采一个 target 的元数据并落库。
 *
 * @param opts.sources 本轮要采的来源;缺省 = 定时来源(只有 glue)
 * @param opts.projectId 采数仓目录时必填(见 `pullWarehouseCatalog`)
 *
 * 🔴 **一个来源失败不掀翻另一个**,也不清掉上一次成功的时间戳:
 * 失败只在该来源的 report 上留 `error` + `attemptedAt`,`at`(上次成功)原样保留 ——
 * 否则一次网络抖动就把"3 分钟前采过"变成"从未同步",用户会以为功能坏了。
 */
export async function mirrorMetadata(
  targetId: string,
  opts: {
    sources?: readonly MirrorSource[];
    /**
     * 非定时来源的采集器(目前只有 `redshift`)。🔴 **必须由调用方注入** ——
     * 本模块刻意不 import 它(编译边界 + 它需要 projectId,见「来源二」那段注释)。
     */
    pullers?: Partial<Record<MirrorSource, MirrorSourcePuller>>;
    now?: number;
  } = {}
): Promise<MirrorRunResult> {
  const now = opts.now ?? Date.now();
  const sources = opts.sources && opts.sources.length ? opts.sources : MIRROR_TIMER_SOURCES;
  const prev = await readFacetItem(targetId);
  const prevReports = new Map<MirrorSource, MirrorSourceReport>(
    (prev?.sources ?? []).map((s) => [s.source, s])
  );

  const region = await regionOfTarget(targetId);
  const nowIso = new Date(now).toISOString();
  const reports: MirrorSourceReport[] = [];
  const pulled: PulledEntry[] = [];
  let truncated = false;
  // 🔴 每个来源本轮的完整性 —— 差集删除(镜像 + OM)只许在**确知完整**时做
  const pullFacts = new Map<MirrorSource, { truncated: boolean; unread: Set<string> }>();

  for (const source of sources) {
    const base: MirrorSourceReport = {
      source,
      ok: false,
      databases: 0,
      tables: 0,
      columns: 0,
      attemptedAt: nowIso,
    };
    try {
      const out = source === "glue" ? await pullGlueCatalog(region) : await requirePuller(opts.pullers, source)(targetId);
      for (const e of out.entries) assertFqnMatchesSource(e.fqn, source);
      pulled.push(...out.entries);
      truncated = truncated || out.truncated;
      pullFacts.set(source, { truncated: out.truncated, unread: new Set(out.unreadDatabases) });
      reports.push({
        ...base,
        ok: true,
        at: nowIso,
        databases: out.databases,
        tables: out.tables,
        columns: out.columns,
      });
    } catch (e) {
      const old = prevReports.get(source);
      reports.push({
        ...base,
        // 🔴 保留上一次成功的时间与计数(失败不等于"那个区什么都没有")
        ...(old?.at ? { at: old.at, databases: old.databases, tables: old.tables, columns: old.columns } : {}),
        error: String((e as Error)?.message ?? e).slice(0, 600),
      });
    }
  }

  // 🔴🔴 **删除范围必须只看「本轮」**(W3-e 真环境 W3e-12 抓到的 bug):
  //    `reports` 马上要把「上一轮保留下来的报告」也拼进去,而那些报告的 `ok` 是**历史上的成功**。
  //    第一版拿 `reports.filter(ok)` 算删除范围 ⇒ 一次 glue-only 的定时刷新把
  //    「历史上成功过的 redshift」也当成本轮采过 ⇒ 65 条手动采的数仓条目**全被删**
  //    (界面上就是「数仓目录莫名消失」,而且每 30min 复发一次)。
  //    ⇒ 在拼保留报告**之前**就把本轮成功的来源定死。
  const okSources = new Set(reports.filter((r) => r.ok).map((r) => r.source));

  // 上一轮里**本次没采的来源**原样保留(glue-only 定时不许抹掉手动采的数仓目录)
  for (const [src, rep] of Array.from(prevReports.entries())) {
    if (!sources.includes(src)) reports.push(rep);
  }

  const ttlSec = Math.floor((now + MIRROR_TTL_MS) / 1000);
  if (okSources.size) {
    const seen = new Set(pulled.map((e) => mirrorSk(e.kind, e.fqn)));
    const existing = await listExistingSks(targetId);
    const stale = existing.filter((sk) => {
      if (sk === MIRROR_FACET_SK) return false;
      const parsed = parseMirrorSk(sk);
      if (!parsed) return false;
      const src = sourceOfFqn(parsed.fqn);
      // 🔴 只删**本轮采成功的来源**的条目(见文件头 ④)
      if (src === null || !okSources.has(src) || seen.has(sk)) return false;
      // 🔴 被截断的来源不删(截断外的条目本轮没看见 ≠ 不存在);读失败的库里一条都不删
      const facts = pullFacts.get(src);
      if (!facts || facts.truncated) return false;
      return !facts.unread.has(parsed.fqn.split(".")[1] ?? "");
    });
    await chunkedWrite([
      ...pulled.map((e) => ({
        PutRequest: {
          Item: {
            pk: mirrorPk(targetId),
            sk: mirrorSk(e.kind, e.fqn),
            kind: e.kind,
            fqn: e.fqn,
            payload: e.payload,
            mirroredAt: nowIso,
            ttl: ttlSec,
          },
        },
      })),
      ...stale.map((sk) => ({ DeleteRequest: { Key: { pk: mirrorPk(targetId), sk } } })),
    ]);
  }

  // 🔴🔴 **用户 2026-09-10 拍板「治理目录必须走同一个 OpenMetaData」** ⇒ 采到的东西**顺手推进 OM**,
  //    目录页因此只读 OM 一条路(「哪个区」= OM 里的 per-target service,见 `om-service.ts`)。
  // 🔴 放在这里(镜像写完之后)而不是各来源里:一轮采集**一次推送**,而且推的正是「本轮真看见的」——
  //    与镜像自己的「本轮没看见就删」同一份事实,不会出现「镜像里没了、OM 里还在推」。
  // 🔴 推送失败**不打断镜像**(镜像本身已经写好了),但**必须报出来**:推不进 OM = 目录页那个区
  //    停在上一次的样子,而页面上看不出来 ⇒ 结果里带 `om`,管理面据此显示。
  let om: MirrorRunResult["om"];
  try {
    const { pushMirrorToOpenMetadata } = await import("@/lib/openmetadata/om-mirror-push");
    const r = await pushMirrorToOpenMetadata({ targetId, entries: pulled });
    om = { tables: r.tables, services: r.services, truncated: r.truncated, errors: r.errors.length };
    // 🔴🔴 根治:推完再对账 —— OM 里本轮完整采集没看见的表 ⇒ 软删(护栏见 om-reconcile.ts 文件头)。
    //   只对**本轮采成功**的来源做;每个来源一份结果,`skipped` 说明为什么这一轮没删。
    const { reconcileOmTables } = await import("@/lib/openmetadata/om-reconcile");
    om.reconcile = [];
    for (const source of Array.from(okSources)) {
      const facts = pullFacts.get(source);
      const rr = await reconcileOmTables({
        targetId,
        source,
        seen: pulled.filter((e) => e.kind === "table" && sourceOfFqn(e.fqn) === source).map((e) => e.fqn),
        complete: !!facts && !facts.truncated,
        unreadDatabases: Array.from(facts?.unread ?? []),
      });
      om.reconcile.push(rr);
      if (rr.errors.length || rr.skipped) {
        console.error("[mirror→om] %s/%s 对账:skipped=%s deleted=%d errors=%s", targetId, source, rr.skipped ?? "-", rr.deleted,
          rr.errors.slice(0, 3).map((e) => `${e.fqn}:${e.error}`).join(" | ") || "-");
      }
    }
    if (r.errors.length) {
      console.error("[mirror→om] %s 有 %d 张表没推进 OM:%s", targetId, r.errors.length,
        r.errors.slice(0, 3).map((e) => `${e.fqn}:${e.error}`).join(" | "));
    }
  } catch (e) {
    om = { tables: 0, services: [], truncated: false, errors: -1, error: String((e as Error)?.message ?? e).slice(0, 300) };
    console.error("[mirror→om] %s 整体推送失败:%s", targetId, om.error);
  }

  const facet = await writeFacet({ targetId, region, reports, truncated, now, ttlSec });
  return { targetId, facet, sources: Array.from(sources), om };
}

/**
 * 取注入的采集器。🔴 没注入就**拒**,而不是"跳过这个来源"——
 * 静默跳过会让调用方以为采过了(分面上那一行永远停在「未采集过」而没人知道为什么)。
 */
function requirePuller(
  pullers: Partial<Record<MirrorSource, MirrorSourcePuller>> | undefined,
  source: MirrorSource
): MirrorSourcePuller {
  const p = pullers?.[source];
  if (!p) {
    throw new Error(
      `来源 ${source} 需要调用方注入采集器(它要请求上下文里的 projectId,§3.9b)—— ` +
        `定时循环拿不到,所以只能由管理面路由触发`
    );
  }
  return p;
}

// ── 分面读写 ─────────────────────────────────────────────────────────────────

interface FacetItem {
  targetId: string;
  region: string;
  mirroredAt?: string;
  ttl?: number;
  sources: MirrorSourceReport[];
  truncated: boolean;
}

async function readFacetItem(targetId: string): Promise<FacetItem | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLES.METADATA_MIRROR, Key: { pk: FACET_PK, sk: targetId } })
  );
  const it = r.Item as (FacetItem & { payload?: FacetItem }) | undefined;
  if (!it) return null;
  const p = it.payload ?? (it as FacetItem);
  return {
    targetId,
    region: String(p.region ?? ""),
    ...(p.mirroredAt ? { mirroredAt: String(p.mirroredAt) } : {}),
    ...(typeof it.ttl === "number" ? { ttl: it.ttl } : {}),
    sources: Array.isArray(p.sources) ? p.sources : [],
    truncated: p.truncated === true,
  };
}

async function writeFacet(args: {
  targetId: string;
  region: string;
  reports: MirrorSourceReport[];
  truncated: boolean;
  now: number;
  ttlSec: number;
}): Promise<MirrorFacet> {
  // 🔴 分面的 `mirroredAt` **只取定时来源**(glue):手动采的数仓目录另有自己的时间戳。
  //    混起来取 max 就会出现"Glue 3min 前 ✓"掩盖"数仓目录是 3 天前手动采的"。
  const timer = args.reports.filter((r) => MIRROR_TIMER_SOURCES.includes(r.source));
  const mirroredAt = timer.map((r) => r.at).filter(Boolean).sort()[0];
  const item = {
    pk: FACET_PK,
    sk: args.targetId,
    payload: {
      targetId: args.targetId,
      region: args.region,
      ...(mirroredAt ? { mirroredAt } : {}),
      sources: args.reports,
      truncated: args.truncated,
    },
    mirroredAt: mirroredAt ?? null,
    ttl: args.ttlSec,
  };
  await chunkedWrite([{ PutRequest: { Item: item } }]);
  return facetFromItem(
    {
      targetId: args.targetId,
      region: args.region,
      ...(mirroredAt ? { mirroredAt } : {}),
      ttl: args.ttlSec,
      sources: args.reports,
      truncated: args.truncated,
    },
    { active: true, jurisdiction: "" },
    args.now
  );
}

function facetFromItem(
  it: FacetItem,
  meta: { active: boolean; jurisdiction: string },
  now: number
): MirrorFacet {
  const timer = it.sources.filter((s) => MIRROR_TIMER_SOURCES.includes(s.source));
  const timerError = timer.find((s) => s.error)?.error;
  const counted = timer;
  const warehouseRep = it.sources.find((s) => s.source === "redshift");
  return {
    targetId: it.targetId,
    region: it.region,
    jurisdiction: meta.jurisdiction,
    isHome: isHome(it.targetId),
    active: meta.active,
    ...(it.mirroredAt ? { mirroredAt: it.mirroredAt } : {}),
    ...(typeof it.ttl === "number" ? { ttl: it.ttl } : {}),
    state: mirrorFacetState({ mirroredAt: it.mirroredAt, ttl: it.ttl, error: timerError, now }),
    databases: counted.reduce((a, s) => a + (s.databases || 0), 0),
    tables: counted.reduce((a, s) => a + (s.tables || 0), 0),
    columns: counted.reduce((a, s) => a + (s.columns || 0), 0),
    sources: it.sources,
    ...(warehouseRep
      ? {
          warehouse: {
            ...warehouseRep,
            // 数仓目录**自己判自己的态**(它不参与上面那个 ✓/⚠)
            state: mirrorFacetState({ mirroredAt: warehouseRep.at, ttl: it.ttl, error: warehouseRep.error, now }),
          },
        }
      : {}),
    truncated: it.truncated,
    cap: MIRROR_MAX_ENTRIES,
  };
}

/** 一屏总览:列 **活跃 ∪ 有过镜像** 的全部 target。 */
export async function buildMirrorOverview(now = Date.now()): Promise<MirrorOverview> {
  const warnings: string[] = [];
  const { listActiveTargets } = await import("@/lib/exec-env/registry");
  let active: Array<{ targetId: string; region?: string; jurisdiction?: string }> = [];
  try {
    active = (await listActiveTargets()) as Array<{ targetId: string; region?: string; jurisdiction?: string }>;
  } catch (e) {
    // 🔴 **不静默回落成"只有 home"**:那会让非 home 的分面整列消失 = 隐藏问题(同矩阵)。
    throw new Error(
      `读取执行目标清单失败,无法可靠地算跨地域总览(缺分面在界面上等于"那个区不存在"):${String((e as Error)?.message ?? e)}`
    );
  }
  const meta = new Map(
    active.map((t) => [t.targetId, { active: true, jurisdiction: String(t.jurisdiction || "home"), region: String(t.region || "") }])
  );

  const items: FacetItem[] = [];
  try {
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await docClient.send(
        new QueryCommand({
          TableName: TABLES.METADATA_MIRROR,
          KeyConditionExpression: "pk = :p",
          ExpressionAttributeValues: { ":p": FACET_PK },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        })
      );
      for (const raw of (r.Items ?? []) as Array<{ sk?: string; ttl?: number; payload?: FacetItem }>) {
        if (!raw.sk || !raw.payload) continue;
        items.push({
          targetId: raw.sk,
          region: String(raw.payload.region ?? ""),
          ...(raw.payload.mirroredAt ? { mirroredAt: String(raw.payload.mirroredAt) } : {}),
          ...(typeof raw.ttl === "number" ? { ttl: raw.ttl } : {}),
          sources: Array.isArray(raw.payload.sources) ? raw.payload.sources : [],
          truncated: raw.payload.truncated === true,
        });
      }
      startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!startKey) break;
    }
  } catch (e) {
    // 镜像表读不了 ⇒ 分面全空。**说出来**,不让页面显示"每个区都从未同步"(那是另一种谎)
    warnings.push(`读镜像表失败:${String((e as Error)?.message ?? e)}`);
  }

  const byTarget = new Map(items.map((i) => [i.targetId, i]));
  const ids = Array.from(
    new Set([HOME_TARGET_ID, ...Array.from(meta.keys()), ...Array.from(byTarget.keys())])
  );
  const facets = ids
    .map((targetId) => {
      const m = meta.get(targetId);
      const it =
        byTarget.get(targetId) ??
        // 从没采过的 target:照实给一个 `never` 分面(不隐藏 —— 隐藏就等于"这个区没资产")
        ({ targetId, region: m?.region ?? "", sources: [], truncated: false } as FacetItem);
      if (!it.region && m?.region) it.region = m.region;
      return facetFromItem(it, { active: !!m, jurisdiction: m?.jurisdiction ?? "" }, now);
    })
    .sort((a, b) => (a.isHome ? -1 : b.isHome ? 1 : a.targetId.localeCompare(b.targetId)));

  return {
    facets,
    totals: {
      databases: facets.reduce((a, f) => a + f.databases, 0),
      tables: facets.reduce((a, f) => a + f.tables, 0),
      columns: facets.reduce((a, f) => a + f.columns, 0),
    },
    notCollected: NOT_COLLECTED,
    needSync: facets.filter((f) => f.state !== "fresh").length,
    warnings,
  };
}

/** 下钻:某个 target 的镜像条目(库/表)。**只读镜像,不碰那个区的数据面**。 */
export async function listMirrorEntries(
  targetId: string,
  kind?: MirrorKind,
  limit = 500
): Promise<Array<{ kind: MirrorKind; fqn: string; payload: Record<string, unknown>; mirroredAt?: string }>> {
  const out: Array<{ kind: MirrorKind; fqn: string; payload: Record<string, unknown>; mirroredAt?: string }> = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.METADATA_MIRROR,
        KeyConditionExpression: kind ? "pk = :p AND begins_with(sk, :k)" : "pk = :p",
        ExpressionAttributeValues: { ":p": mirrorPk(targetId), ...(kind ? { ":k": `${kind}#` } : {}) },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const raw of (r.Items ?? []) as Array<{ sk?: string; payload?: Record<string, unknown>; mirroredAt?: string; ttl?: number }>) {
      if (!raw.sk || raw.sk === MIRROR_FACET_SK) continue;
      const parsed = parseMirrorSk(raw.sk);
      if (!parsed) continue;
      // 🔴 自己判 ttl:DDB 懒删最长 48h,过期条目照样会被 Query 返回(见 shared 文件头 ②)
      if (typeof raw.ttl === "number" && raw.ttl * 1000 <= Date.now()) continue;
      if (out.length >= limit) break;
      out.push({
        kind: parsed.kind,
        fqn: parsed.fqn,
        payload: (raw.payload ?? {}) as Record<string, unknown>,
        ...(raw.mirroredAt ? { mirroredAt: String(raw.mirroredAt) } : {}),
      });
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  return out;
}

/** 定时循环用:这个 target 该不该刷(按分面的定时来源时间戳判)。 */
export async function mirrorDueTargets(now = Date.now()): Promise<string[]> {
  const { MIRROR_REFRESH_MS } = await import("@/lib/exec-env/metadata-mirror-shared");
  const { listActiveTargets } = await import("@/lib/exec-env/registry");
  const active = (await listActiveTargets()) as Array<{ targetId: string }>;
  const due: string[] = [];
  for (const t of active) {
    const it = await readFacetItem(t.targetId);
    const at = it?.mirroredAt ? Date.parse(it.mirroredAt) : NaN;
    if (!Number.isFinite(at) || now - at >= MIRROR_REFRESH_MS) due.push(t.targetId);
  }
  return due;
}
