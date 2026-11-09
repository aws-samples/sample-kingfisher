/**
 * 同步任务「写哪个 S3 Tables 表桶」的**唯一作者**(2026-10-27 起;2026-11-04 改为按路由表判)。
 *
 * 【缺陷原形(客户 2026-10-27:「当执行环境设置了 bucket,我再指定 ods 的 bucket,提交同步任务会报错」;测试账号页面驱动复现 5/5)】
 *   非主控区执行环境的同步任务在向导里给 Table Bucket 填了**自有表桶**:「完成」能建成,「启动」409「任务自带的表桶 … 与执行环境 …
 *   的表桶 … 不一致 ⇒ 拒绝」;登记后再启动**仍是同一句**。主控区允许任意自有桶、执行区一律拒 ⇒ 客户在非主控区没法把 ODS 落进自己的表桶。
 * 【根治】
 *   · `effectiveTableBucket(task, landing)`:任务真正写入的桶,start-run / 生成器 / 目标表守卫三处共用(以前各写一遍 `||`);
 *   · 「系统设置 → 数据湖表桶与路由」= 该执行环境**可写外部桶的唯一事实源**(登记一次 = 可见 + 可写):保存(POST / PUT)与启动
 *     都按 `tableBucketRejection` 判「自带桶 ∈ 本区路由 且 writable」,否则拒绝并指路去登记;
 *   · 执行区 Glue / EMR 角色的 `s3tables:*` 放到**同区任意表桶**(infra `tableBucketAnyArn`,仍由 ARN 的区段绑区)。
 * 【数据湖表桶路由(设计稿 §6.5.3 / D4)】主控区**不再**任意桶放行:home 与非 home 同一条规则「必须是路由」;存量 home 任务写着的
 *   未登记桶由升级步 2c‴(scripts/lib/lake-routes-migrate.mjs)自动登记为路由;`writable=false` 的路由不能当同步目标
 *   (保存 400 / 启动 409 `LAKE_ROUTE_NOT_WRITABLE`)。
 * 🔴 路由表**fresh 读**(绕过 15s 缓存):这是写侧判定,登记完下一秒就要能过,且两个 ECS 任务各有一份缓存。
 */
import { LAKE_ROUTES_PAGE_PATH, LakeRouteError, lakeRoutesOfLanding, platformRouteOf, type LakeRoute, type LakeRouteErrorCode } from "@/lib/lake/routes";
import { bindingTargets, resolveGlueBinding, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { TargetNotReadyError } from "@/lib/exec-env/registry";

export interface TableBucketTaskShape {
  s3Config?: { tableBucket?: unknown } | null;
}

/** 判定要用的落点四样(`resolveGlueBinding` 的产物本来就有;判据可直接造)。数据湖表桶路由:平台路由从它派生(targetId / region / tableBucket / home),不再解析第二次。 */
export interface TableBucketLanding {
  targetId: string;
  tableBucket: string;
  home: boolean;
  region: string;
}

/** 页面上登记路由的位置(拒绝文案 / 下拉提示都指它;与 app/settings 的卡片标题同词;唯一作者在 lib/lake/routes.ts)。 */
export const TABLE_BUCKET_REGISTRY_PATH = LAKE_ROUTES_PAGE_PATH;

/** 任务自带的表桶(去空白;没填 / 不是字符串 ⇒ 空串)。 */
export function ownTableBucketOf(task: TableBucketTaskShape): string {
  const v = task.s3Config?.tableBucket;
  return typeof v === "string" ? v.trim() : "";
}

/** 任务真正写入的表桶:自带优先,否则落点的平台表桶。🔴 三个消费点(start-run / 生成器 / 目标表守卫)只许用它,不许各写一遍 `||`。 */
export function effectiveTableBucket(task: TableBucketTaskShape, landing: { tableBucket: string }): string {
  return ownTableBucketOf(task) || landing.tableBucket;
}

export interface WritableTableBuckets {
  platform: string;
  /** 已登记且 writable 的外部路由桶 */
  registered: string[];
}

/** 某执行环境可写的表桶 = 平台表桶 ∪ 可写外部路由(路由表 fresh 读,见文件头;平台路由从落点派生)。 */
export async function writableTableBuckets(landing: TableBucketLanding): Promise<WritableTableBuckets> {
  const set = await lakeRoutesOfLanding(landing, { fresh: true });
  return { platform: landing.tableBucket, registered: set.external.filter((r) => r.writable).map((r) => r.bucket) };
}

export type TableBucketRejectCode = Extract<LakeRouteErrorCode, "LAKE_ROUTE_NOT_FOUND" | "LAKE_ROUTE_NOT_WRITABLE">;

export interface TableBucketRejection {
  code: TableBucketRejectCode;
  message: string;
}

/** 「不是路由」的拒绝文案(保存 400 / 启动 409 同一句;告诉用户是哪个桶、为什么、下一步做什么)。 */
export function tableBucketRejectionMessage(own: string, landing: TableBucketLanding, registered: readonly string[]): string {
  return (
    `执行环境 ${landing.targetId} 不能写入表桶「${own}」:它既不是该执行环境的平台表桶「${landing.tableBucket}」,` +
    `也没有在「${TABLE_BUCKET_REGISTRY_PATH}」为该执行环境登记为路由。请先去登记(登记一次 = 同步可写入、直查 / 治理目录 / 问数可见),` +
    `或把 Table Bucket 清空改用平台表桶` +
    (registered.length ? `;该执行环境可写的路由:${registered.join("、")}` : "")
  );
}

/** 「路由只读」的拒绝文案。 */
export function tableBucketReadOnlyMessage(route: Pick<LakeRoute, "bucket" | "alias">, landing: TableBucketLanding): string {
  return (
    `执行环境 ${landing.targetId} 的数据湖路由「${route.alias}」(${route.bucket})登记为只读,同步任务不能把它选为 Table Bucket。` +
    `请在「${TABLE_BUCKET_REGISTRY_PATH}」把它改为可写,或换一个可写的路由`
  );
}

/**
 * 自带表桶能不能在该落点写(唯一判定;home 与非 home 同一条规则):
 * · 没自带 / 自带 == 平台表桶 ⇒ 放行(不读路由表);
 * · 自带桶 ∈ 本区外部路由且 writable ⇒ 放行;只读 ⇒ LAKE_ROUTE_NOT_WRITABLE;不是路由 ⇒ LAKE_ROUTE_NOT_FOUND。
 * @returns null = 放行;否则 { code, message }
 */
export async function tableBucketRejection(task: TableBucketTaskShape, landing: TableBucketLanding): Promise<TableBucketRejection | null> {
  const own = ownTableBucketOf(task);
  if (!own || own === landing.tableBucket) return null;
  const set = await lakeRoutesOfLanding(landing, { fresh: true });
  const route = set.external.find((r) => r.bucket === own);
  if (!route) return { code: "LAKE_ROUTE_NOT_FOUND", message: tableBucketRejectionMessage(own, landing, set.external.filter((r) => r.writable).map((r) => r.bucket)) };
  if (!route.writable) return { code: "LAKE_ROUTE_NOT_WRITABLE", message: tableBucketReadOnlyMessage(route, landing) };
  return null;
}

/**
 * 任务真正写入的那条路由(注入 Spark 目录 / 脚本里的目录别名用)。自带桶 == 平台表桶或没自带 ⇒ 平台路由(纯函数,不读 DDB);
 * 自带外部桶 ⇒ 路由表 fresh 读;不是路由 / 只读 ⇒ 抛 LakeRouteError(调用方应先过 `tableBucketRejection`)。
 */
export async function effectiveLakeRoute(task: TableBucketTaskShape, landing: TableBucketLanding): Promise<LakeRoute> {
  const own = ownTableBucketOf(task);
  if (!own || own === landing.tableBucket) return platformRouteOf({ targetId: landing.targetId, region: landing.region, tableBucket: landing.tableBucket });
  const set = await lakeRoutesOfLanding(landing, { fresh: true });
  const route = set.external.find((r) => r.bucket === own);
  if (!route) throw new LakeRouteError("LAKE_ROUTE_NOT_FOUND", 400, tableBucketRejectionMessage(own, landing, set.external.filter((r) => r.writable).map((r) => r.bucket)), { targetId: landing.targetId, bucket: own });
  if (!route.writable) throw new LakeRouteError("LAKE_ROUTE_NOT_WRITABLE", 400, tableBucketReadOnlyMessage(route, landing), { targetId: landing.targetId, bucket: own, alias: route.alias });
  return route;
}

export interface TableBucketSaveRejection {
  status: 400;
  code: TableBucketRejectCode | "VALIDATION_FAILED";
  message: string;
}

/**
 * 保存路由(POST / PUT)用:任务自带表桶时按任务的章解析落点再判(调用方先判 `writesS3Tables`,不写 S3 Tables 的任务不多读)。
 * 落点解析被拒(执行环境没就位 / 资源袋缺项)也如实 400 —— 不知道落点就无法判桶,不放行。
 */
export async function tableBucketSaveRejection(
  task: TableBucketTaskShape & { targets?: unknown; targetId?: unknown }
): Promise<TableBucketSaveRejection | null> {
  const own = ownTableBucketOf(task);
  if (!own) return null;
  const tid = bindingTargets(task)[0];
  let landing: TableBucketLanding;
  try {
    landing = await resolveGlueBinding({ targetId: tid });
  } catch (e) {
    // 两类都是「用户可修」(执行环境没就位 / 资源袋缺项 / 没装 core),按 400 报并带原话;凭证 / 限流之类照旧抛(不许吞成放行)
    if (e instanceof TargetBindingRejected || e instanceof TargetNotReadyError) {
      return { status: 400, code: "VALIDATION_FAILED", message: `无法按执行环境 ${tid} 校验 Table Bucket「${own}」:${e.message}` };
    }
    throw e;
  }
  const r = await tableBucketRejection(task, landing);
  return r ? { status: 400, code: r.code, message: r.message } : null;
}
