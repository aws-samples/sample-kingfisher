// 数据湖表桶路由—— 作业的**数据湖表桶声明**(D2 / D3):形状校验 + 按绑定区解析成「被选中的路由」+ 保存期校验(§6.10.6)。
//
// 字段(Glue 作业 `glueConfig` / EMR 作业顶层):
//   lakeBuckets?: { bucket, access: "read" | "write" }[]   —— 不给 = 本区全部路由(访问随 writable)
//   defaultCatalogAlias?: string                           —— 必须是本作业目录之一(两段名走它;跨目录仍要三段名)
// 保存路由(POST / PUT /api/etl-jobs、/api/engines)逐绑定区校验:桶不是路由 ⇒ 400 LAKE_ROUTE_NOT_FOUND;写只读路由 ⇒ 400 LAKE_ROUTE_NOT_WRITABLE;
//   缺省目录不在目录里 / --conf 超预算 ⇒ 400 VALIDATION_FAILED;手写目录别名撞桶 ⇒ 400 LAKE_ROUTE_ALIAS_CONFLICT;
//   用户手写的目录被平台接管 ⇒ 响应 `_meta.notices[]`。运行路径(ensureGlueJob / provider.submit)再按同一作者解析一次(不信落库值)。
import { apiError } from "@/lib/api-response";
import {
  LakeRouteError, assertDefaultCatalogAlias, assertGlueConfBudget, assertTableBucketName, isLakeAccessMode, lakeRoutesOfLanding, rejectUserCatalogConf,
  resolveLakeRoutes, selectRoutes, sparkCatalogConf, splitGlueConfValue,
  type LakeBucketDeclaration, type LakeRouteSet, type SelectedRoute, type SparkEngine,
} from "./routes";

export interface LakeDeclaration {
  lakeBuckets?: LakeBucketDeclaration[];
  defaultCatalogAlias?: string;
}

/** 形状校验(闭合清单;不碰 AWS)。`undefined` 字段原样不出现(= 缺省全部路由)。 */
export function normalizeLakeDeclaration(src: { lakeBuckets?: unknown; defaultCatalogAlias?: unknown } | null | undefined): LakeDeclaration {
  const out: LakeDeclaration = {};
  if (src?.lakeBuckets !== undefined && src.lakeBuckets !== null) {
    if (!Array.isArray(src.lakeBuckets)) throw new LakeRouteError("VALIDATION_FAILED", 400, "lakeBuckets 必须是 { bucket, access } 的数组");
    const list: LakeBucketDeclaration[] = [];
    for (const d of src.lakeBuckets as unknown[]) {
      const o = (d ?? {}) as { bucket?: unknown; access?: unknown };
      const bucket = assertTableBucketName(o.bucket);
      if (!isLakeAccessMode(o.access)) throw new LakeRouteError("VALIDATION_FAILED", 400, `数据湖表桶 ${bucket} 的访问方式 ${JSON.stringify(o.access)} 不合法(只能是 read / write)`);
      list.push({ bucket, access: o.access });
    }
    out.lakeBuckets = list;
  }
  if (src?.defaultCatalogAlias !== undefined && src.defaultCatalogAlias !== null && src.defaultCatalogAlias !== "") {
    if (typeof src.defaultCatalogAlias !== "string") throw new LakeRouteError("VALIDATION_FAILED", 400, "defaultCatalogAlias 必须是字符串");
    out.defaultCatalogAlias = src.defaultCatalogAlias.trim();
  }
  return out;
}

export interface ResolvedJobLakeRoutes {
  set: LakeRouteSet;
  selected: SelectedRoute[];
  defaultAlias?: string;
}

/**
 * 按某个绑定区把声明解析成被选中的路由(fresh 读;运行 / 保存两条路都走这一处)。
 * 运行路径手里已有 Spark 落点时传 `landing`(平台路由直接从它派生,不再解析第二次);保存路径没有落点 ⇒ 经 resolveLakeRoutes 按 targetId 解析。
 */
export async function resolveJobLakeRoutes(
  targetId: string,
  decl: LakeDeclaration,
  opts: { landing?: { targetId: string; region: string; tableBucket: string; home: boolean } } = {}
): Promise<ResolvedJobLakeRoutes> {
  const set = opts.landing ? await lakeRoutesOfLanding(opts.landing, { fresh: true }) : await resolveLakeRoutes(targetId, { fresh: true });
  const selected = selectRoutes(set, decl.lakeBuckets);
  const defaultAlias = assertDefaultCatalogAlias(selected, decl.defaultCatalogAlias);
  return { set, selected, ...(defaultAlias ? { defaultAlias } : {}) };
}

export interface LakeDeclarationCheckInput {
  engine: SparkEngine;
  targets: readonly string[];
  decl: LakeDeclaration;
  /** 用户手写的 Spark conf 条目(`k=v`;Glue 取 jobParameters["--conf"] 拆分,EMR 取 sparkConf 的 k=v) */
  userConf: readonly string[];
  account: string;
}

/**
 * 保存期校验(§6.10.6):每个绑定区都要能解析、缺省目录在目录里、手写目录不与路由撞桶、Glue 的 --conf 不超预算。
 * 回 notices(被接管的手写条目说明;保存响应放进 `_meta.notices`)。
 */
export async function checkLakeDeclarationForTargets(input: LakeDeclarationCheckInput): Promise<{ notices: string[] }> {
  const notices: string[] = [];
  for (const targetId of input.targets) {
    const { selected, defaultAlias } = await resolveJobLakeRoutes(targetId, input.decl);
    const verdict = rejectUserCatalogConf(input.userConf, selected, { defaultDeclared: !!defaultAlias });
    for (const n of verdict.notices) if (!notices.includes(n)) notices.push(n);
    if (input.engine === "glue") {
      const conf = [...sparkCatalogConf(selected, { engine: "glue", account: input.account, defaultAlias }), ...verdict.kept].join(" --conf ");
      assertGlueConfBudget(conf);
    }
  }
  return { notices };
}

/** Glue 作业 jobParameters 里用户手写的 `--conf`(键可带或不带 `--`)⇒ 条目。 */
export function userGlueConfEntries(jobParameters: unknown): string[] {
  if (!jobParameters || typeof jobParameters !== "object") return [];
  const p = jobParameters as Record<string, unknown>;
  const raw = p["--conf"] ?? p["conf"];
  return typeof raw === "string" ? splitGlueConfValue(raw) : [];
}

/** EMR 作业 sparkConf(k ⇒ v)⇒ 条目。 */
export function userEmrConfEntries(sparkConf: unknown): string[] {
  if (!sparkConf || typeof sparkConf !== "object") return [];
  return Object.entries(sparkConf as Record<string, unknown>).filter(([k]) => k && k.trim()).map(([k, v]) => `${k.trim()}=${String(v ?? "").trim()}`);
}

/** 路由层:LakeRouteError ⇒ 平台信封(status / code / detail 原样);不是它 ⇒ null。 */
export function lakeRouteErrorResponse(e: unknown) {
  if (!(e instanceof LakeRouteError)) return null;
  return apiError(e.message, e.status, { code: e.code, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
}
