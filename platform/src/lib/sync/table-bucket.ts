/**
 * 同步任务「写哪个 S3 Tables 表桶」的**唯一作者**。
 *
 * 【缺陷原形(客户 2026-10-27:「当执行环境设置了 bucket,我再指定 ods 的 bucket,提交同步任务会报错」;测试账号页面驱动复现 5/5)】
 *   非主控区执行环境的同步任务在向导里给 Table Bucket 填了**自有表桶**:「完成」能建成,「启动」409「任务自带的表桶 … 与执行环境 …
 *   的表桶 … 不一致 ⇒ 拒绝」;在「系统设置 → 数据湖外部表桶」为该执行环境登记该桶后再启动**仍是同一句**。主控区允许任意自有桶、
 *   执行区一律拒 ⇒ 客户在非主控区没法把 ODS 落进自己的表桶。
 * 【根因】① start-run 的守卫按「非 home 只认描述符」写死,没有接该缺陷的外部表桶登记表;② 执行区 Glue / EMR 角色的 `s3tables:*`
 *   只授到该区平台表桶(infra/lib/exec-env/core-stack.ts);③ 附带:目标表守卫探的是执行环境平台表桶而不是任务自带的桶(主控区同样看错桶,潜伏)。
 * 【根治】
 *   · `effectiveTableBucket(task, landing)`:任务真正写入的桶,start-run / 生成器 / 目标表守卫三处共用(以前各写一遍 `||`);
 *   · 「系统设置 → 数据湖外部表桶」登记表 = 该执行环境**可写外部桶的唯一事实源**(登记一次 = 可见 + 可写):保存(POST / PUT)与启动
 *     都按 `tableBucketRejection` 判「自带桶 ∈ {平台表桶} ∪ 已登记外部桶」,否则拒绝并指路去登记;主控区行为不变(历来允许任意自带桶);
 *   · 执行区 Glue / EMR 角色的 `s3tables:*` 放到**同区任意表桶**(infra `tableBucketAnyArn`,仍由 ARN 的区段绑区);
 *   · 向导表桶下拉给未登记的桶打「未登记」标并出可点提示(components/lake/TableBucketPicker)。
 * 🔴 登记表**直读** DDB(`listExternalTableBuckets`),不走 athena/s3tables.ts 的 15s 读缓存:这是写侧判定,登记完下一秒就要能过,
 *   且两个 ECS 任务各有一份缓存 —— 用缓存就会出现「这台说登记了、那台说没有」。
 */
import { listExternalTableBuckets } from "@/lib/lake/external-table-buckets";
import { bindingTargets, resolveGlueBinding, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { TargetNotReadyError } from "@/lib/exec-env/registry";

export interface TableBucketTaskShape {
  s3Config?: { tableBucket?: unknown } | null;
}

/** 判定要用的落点三样(`resolveGlueBinding` 的产物本来就有;判据可直接造)。 */
export interface TableBucketLanding {
  targetId: string;
  tableBucket: string;
  home: boolean;
}

/** 页面上登记外部表桶的位置(拒绝文案 / 下拉提示都指它;与 app/settings 的卡片标题同词)。 */
export const TABLE_BUCKET_REGISTRY_PATH = "系统设置 → 数据湖外部表桶";

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
  registered: string[];
}

/** 某执行环境可写的表桶 = 平台表桶 ∪ 已登记外部表桶(登记表直读,见文件头)。 */
export async function writableTableBuckets(landing: { targetId: string; tableBucket: string }): Promise<WritableTableBuckets> {
  const registered = (await listExternalTableBuckets(landing.targetId)).map((x) => x.bucket);
  return { platform: landing.tableBucket, registered };
}

/** 拒绝文案(保存 400 / 启动 409 同一句;告诉用户是哪个桶、为什么、下一步做什么)。 */
export function tableBucketRejectionMessage(own: string, landing: TableBucketLanding, registered: readonly string[]): string {
  return (
    `执行环境 ${landing.targetId} 不能写入表桶「${own}」:它既不是该执行环境的平台表桶「${landing.tableBucket}」,` +
    `也没有在「${TABLE_BUCKET_REGISTRY_PATH}」为该执行环境登记。请先去登记(登记一次 = 同步可写入、直查 / 治理目录 / 问数可见),` +
    `或把 Table Bucket 清空改用平台表桶` +
    (registered.length ? `;该执行环境已登记可用:${registered.join("、")}` : "")
  );
}

/**
 * 自带表桶能不能在该落点写(唯一判定):
 * · 没自带 / 自带 == 平台表桶 ⇒ 放行;
 * · 主控区 ⇒ 放行(行为不变:主控区历来允许任意自带桶,启动时不存在会自动建);
 * · 非主控区 ⇒ 自带桶必须 ∈ 已登记外部表桶,否则回拒绝文案。
 * @returns null = 放行;string = 拒绝文案
 */
export async function tableBucketRejection(task: TableBucketTaskShape, landing: TableBucketLanding): Promise<string | null> {
  const own = ownTableBucketOf(task);
  if (!own || own === landing.tableBucket || landing.home) return null;
  const { registered } = await writableTableBuckets(landing);
  if (registered.includes(own)) return null;
  return tableBucketRejectionMessage(own, landing, registered);
}

export interface TableBucketSaveRejection {
  status: 400;
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
      return { status: 400, message: `无法按执行环境 ${tid} 校验 Table Bucket「${own}」:${e.message}` };
    }
    throw e;
  }
  const message = await tableBucketRejection(task, landing);
  return message ? { status: 400, message } : null;
}
