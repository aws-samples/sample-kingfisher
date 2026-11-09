// (客户 2026-10-16 待改进项)—— 「数据湖配置」入口的表桶下拉清单,唯一作者。
//   客户原话:数据源支持配置 S3 Table,但数据湖配置入口没有下拉选择能力。
//   同步任务「S3 Tables 数据湖配置 → Table Bucket」与系统设置「数据湖表桶与路由 → 登记」两处原来都只能手填表桶名;
//   现在按执行环境列出该区账号内全部 S3 Tables 表桶(只读 ListTableBuckets,分页取全),并标出「该区平台表桶」「已登记外部表桶」。
//   数据湖表桶路由:已登记的候选再带路由元数据 alias / tier / writable(§6.10.5),向导下拉据此显示「桶 · 别名 · 分层」并只让可写路由被选。
//   🔴 只读:不建桶、不改登记。拉不到(SCP 拒 / 区不可达)时由路由如实报 502,页面侧(components/lake/TableBucketPicker)仍允许手填。
//   落点:由调用方点名 targetId(路由经 requestedTargetId,缺 ⇒ 400),区 / 平台表桶 / 路由表由 lib/lake/routes 唯一作者解析。
import { ListTableBucketsCommand, S3TablesClient } from "@aws-sdk/client-s3tables";
import { sdkClient } from "@/lib/aws/clients";
import type { LakeTier } from "./routes-grammar";

export interface TableBucketCandidate {
  name: string;
  arn: string;
  createdAt?: string;
  /** true = 该执行环境的平台表桶(部署期建,默认就在表树里) */
  platform: boolean;
  /** true = 平台管理员已登记的外部表桶(路由) */
  registered: boolean;
  /** 数据湖表桶路由:路由元数据(平台表桶与已登记的才有;未登记的候选没有) */
  alias?: string;
  tier?: LakeTier;
  writable?: boolean;
}

export interface TableBucketCandidates {
  targetId: string;
  region: string;
  /** 该执行环境是不是主控区 —— 页面据此决定「未登记」提示的措辞(主控区能写但读面看不见;非主控区保存 / 启动会被拒);由服务端说,页面不按 id 猜 */
  home: boolean;
  platformBucket: string;
  /** 排序:平台表桶 → 已登记 → 其余按名 */
  buckets: TableBucketCandidate[];
}

export interface ListTableBucketCandidatesOptions {
  /** 判据注入用;缺省按落点区建 s3tables 客户端 */
  s3tablesClient?: { send(cmd: unknown): Promise<unknown> };
}

type ListPage = {
  tableBuckets?: Array<{ name?: string; arn?: string; createdAt?: Date | string }>;
  continuationToken?: string;
};

export async function listTableBucketCandidates(
  targetId: string,
  opts: ListTableBucketCandidatesOptions = {},
): Promise<TableBucketCandidates> {
  const { resolveS3TablesPlace } = await import("@/lib/athena/s3tables");
  const { resolveLakeRoutes } = await import("@/lib/lake/routes");
  const place = await resolveS3TablesPlace(targetId);
  // 路由表 fresh 读(登记完下一秒下拉就要带标)
  const routes = await resolveLakeRoutes(place.targetId, { fresh: true });
  const byBucket = new Map(routes.all.map((r) => [r.bucket, r]));
  const c = opts.s3tablesClient ?? sdkClient("data-plane", S3TablesClient, { region: place.region });

  const buckets: TableBucketCandidate[] = [];
  let token: string | undefined;
  do {
    const page = (await c.send(new ListTableBucketsCommand(token ? { continuationToken: token } : {}))) as ListPage;
    for (const b of page.tableBuckets ?? []) {
      const name = String(b.name ?? "");
      if (!name) continue;
      const createdAt = b.createdAt instanceof Date ? b.createdAt.toISOString() : typeof b.createdAt === "string" ? b.createdAt : undefined;
      const route = byBucket.get(name);
      buckets.push({
        name,
        arn: String(b.arn ?? ""),
        ...(createdAt ? { createdAt } : {}),
        platform: name === place.bucket,
        registered: !!route && !route.platform,
        ...(route ? { alias: route.alias, tier: route.tier, writable: route.writable } : {}),
      });
    }
    token = page.continuationToken;
  } while (token);

  buckets.sort((a, b) => Number(b.platform) - Number(a.platform) || Number(b.registered) - Number(a.registered) || a.name.localeCompare(b.name));
  return { targetId: place.targetId, region: place.region, home: place.home, platformBucket: place.bucket, buckets };
}
