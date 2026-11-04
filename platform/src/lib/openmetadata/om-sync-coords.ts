// 🔴🔴 **同步任务在 OpenMetadata 里的坐标** —— service / 库 / schema / 表 FQN 的**单一作者**。
//
// 【为什么要它(登记 o4-REG 的根)】同步启动推送(`pushSyncToOpenMetadata`)、物理端点富化
//   (`pushPhysicalEndpointsToOM`)、成功后的列回填与血缘重推,原来**各自**在函数里拼 FQN,
//   而且拼法全是主控区口径:service 是常量 `bgp-sources` / `bgp-s3tables` / `bgp-redshift`,
//   表桶缺省 `bgp-table-bucket`,库缺省 `dev`。非主控区一推,就是把那个区的表挂进主控区的 service
//   (问 A 答 B),所以产品一直对非主控区**整段不推**,治理页那个区的同步表没有 schema、没有列级血缘。
//
// 【现在】「哪个区」= OM 的 service 维度(用户拍板「一个 OpenMetadata」;`omServiceFor` 是唯一命名作者):
//   · 主控区:**逐字节等于改动前**(service 不带后缀、表桶 / 库 / schema 沿用原表达式)—— 存量实体零迁移;
//   · 其它区:service = `<基名>-<targetSlug>`;表桶 / 库 / workgroup **只取该区落点**(start 路由解析出的
//     `landing` / `rsb`,与 Glue 脚本真写的是同一份值);缺一样就抛,**绝不回落主控区的缺省值**;
//     schema 名走 `targetSchemaOf`(脚本真建的那个,小写),库名小写 —— 与目录同步
//     (`SVV_ALL_TABLES` 读回来的 `redshift.<db>.<schema>.<table>`)**落到同一个 OM 实体**上,
//     否则同一张表在 OM 里会有两个实体,列级血缘挂在没人看的那个上(S3 Tables 标识符 FQN 陷阱的同形)。
//   · 源表实体按**数据源的落点**(`ownerTargetId`)选 service,与建数据源时的推送同一个作者。
import { omServiceFor } from "@/lib/openmetadata/om-service";
import { isHome } from "@/lib/exec-env/target-id";
import { sanitizeS3TablesIdentifier } from "@/lib/sync/s3tables-identifier";
import { resolveTargetTableName } from "@/lib/sync/target-naming";
import { targetSchemaOf } from "@/lib/sync/target-table-guard";
import { resolveWorkgroup } from "@/lib/redshift/warehouse-location";

/**
 * 同步任务推 OM 的落点。🔴 必填、无缺省:调用方必须显式给出「这次同步在哪个区跑、源在哪个区」。
 * 非主控区的三样资源值必须来自该区的落点解析(`resolveGlueBinding` / `resolveRedshiftBinding`)。
 */
export interface SyncOmPlace {
  /** 同步任务的执行落点(任务章)。 */
  targetId: string;
  /** 数据源的落点(`ownerTargetId`;同步入口已保证与任务章相同 —— 跨区取数永久拒)。 */
  sourceTargetId: string;
  /** 该区的 S3 Tables 桶(非主控区写湖时必填)。 */
  tableBucket: string | null;
  /** 该区数仓的库名(非主控区写数仓时必填)。 */
  rsDatabase: string | null;
  /** 该区数仓的 workgroup(非主控区写数仓时必填)。 */
  rsWorkgroup: string | null;
}

/** 由 start 路由已解析好的两份落点构造(**纯函数**;start 路由与回填重放共用这一个构造)。 */
export function syncOmPlaceOf(
  landing: { targetId: string; tableBucket: string },
  rsb: { workgroup: string; database: string } | null,
  sourceTargetId: string
): SyncOmPlace {
  return {
    targetId: landing.targetId,
    sourceTargetId,
    tableBucket: landing.tableBucket || null,
    rsDatabase: rsb?.database || null,
    rsWorkgroup: rsb?.workgroup || null,
  };
}

/** 这次同步是不是主控区(主控区 = 逐字节沿用改动前的坐标与回填)。🔴 「是不是主控区」在本链路只判这一处。 */
export function syncOmPlaceIsHome(place: Pick<SyncOmPlace, "targetId">): boolean {
  return isHome(place.targetId);
}

/** 落点不全 ⇒ 不推(调用方当 best-effort 失败记日志)。🔴 不回落主控区缺省值。 */
export class SyncOmPlaceIncomplete extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SyncOmPlaceIncomplete";
  }
}

export interface SyncOmTableCoords {
  /** 源表原名(源系统真名不 sanitize)。 */
  source: string;
  /** 目标物理表名(sanitize 后,与 Glue 脚本逐字一致)。 */
  target: string;
  srcFqn: string;
  /** 不写湖 = ""。 */
  s3Fqn: string;
  /** 不写数仓 = ""。 */
  rsFqn: string;
}

export interface SyncOmCoords {
  home: boolean;
  writeS3: boolean;
  writeRs: boolean;
  services: { src: string; s3t: string; rs: string; physSrc: string; physTgt: string };
  srcDb: string;
  bucket: string;
  namespace: string;
  rsDb: string;
  rsSchema: string;
  workgroup: string;
  srcSchemaFqn: string;
  s3SchemaFqn: string;
  rsSchemaFqn: string;
  tables: SyncOmTableCoords[];
}

interface SyncTaskLike {
  sourceTables?: unknown;
  targetType?: unknown;
  s3Config?: { tableBucket?: string; namespace?: string } | null;
  redshiftConfig?: { database?: string; schema?: string; workgroupName?: string } | null;
  targetTablePrefix?: string;
  targetTableSuffix?: string;
  targetTableNames?: Record<string, string>;
}

/**
 * 同步任务在 OM 里的全部坐标(**纯函数**)。
 * 🔴 主控区分支的每个表达式都与改动前 om-push 里的逐字相同(判据钉逐字节等价)。
 */
export function syncOmCoords(task: SyncTaskLike, ds: { database?: string }, place: SyncOmPlace): SyncOmCoords {
  const tables: string[] = Array.isArray(task.sourceTables) ? (task.sourceTables as string[]) : [];
  const writeS3 = task.targetType === "s3-tables" || task.targetType === "both";
  const writeRs = task.targetType === "redshift" || task.targetType === "both";
  const home = syncOmPlaceIsHome(place);
  const srcDb = ds.database || "source";
  // Bug#1:namespace 过 S3Tables 标识符 SSOT(与 start/route.ts、glue-generator 同一函数同一表达式)
  const namespace = sanitizeS3TablesIdentifier(task.s3Config?.namespace || ds.database || "default");

  let bucket: string;
  let rsDb: string;
  let rsSchema: string;
  let workgroup: string;
  if (home) {
    // ── 主控区:改动前的表达式,一字不改 ──
    bucket = task.s3Config?.tableBucket || "bgp-table-bucket";
    rsDb = task.redshiftConfig?.database || "dev";
    rsSchema = task.redshiftConfig?.schema || "public";
    workgroup = resolveWorkgroup(task.redshiftConfig?.workgroupName);
  } else {
    // ── 其它区:只认该区落点;缺一样就抛 ──
    if (writeS3 && !place.tableBucket) {
      throw new SyncOmPlaceIncomplete(`执行范围 ${place.targetId} 的落点缺表桶 ⇒ 不推 OM(不回落主控区的 bgp-table-bucket)`);
    }
    if (writeRs && (!place.rsDatabase || !place.rsWorkgroup)) {
      throw new SyncOmPlaceIncomplete(`执行范围 ${place.targetId} 的落点缺数仓库名 / workgroup ⇒ 不推 OM(不回落主控区的 dev / bgp-workgroup)`);
    }
    bucket = place.tableBucket || "";
    rsDb = (place.rsDatabase || "").toLowerCase();
    rsSchema = writeRs ? targetSchemaOf(task as Parameters<typeof targetSchemaOf>[0]) : "public";
    workgroup = place.rsWorkgroup || "";
  }

  const services = {
    src: omServiceFor("sources", place.sourceTargetId),
    s3t: omServiceFor("s3tables", place.targetId),
    rs: omServiceFor("redshift", place.targetId),
    physSrc: omServiceFor("physical", place.sourceTargetId),
    physTgt: omServiceFor("physical", place.targetId),
  };
  const srcSchemaFqn = `${services.src}.${srcDb}.default`;
  const s3SchemaFqn = `${services.s3t}.${bucket}.${namespace}`;
  const rsSchemaFqn = `${services.rs}.${rsDb}.${rsSchema}`;
  return {
    home,
    writeS3,
    writeRs,
    services,
    srcDb,
    bucket,
    namespace,
    rsDb,
    rsSchema,
    workgroup,
    srcSchemaFqn,
    s3SchemaFqn,
    rsSchemaFqn,
    tables: tables.map((source) => {
      // Bug#2:目标表实体名 = 真实物理表名 = sanitize(resolveTargetTableName(源名))
      const target = sanitizeS3TablesIdentifier(resolveTargetTableName(source, task), source);
      return {
        source,
        target,
        srcFqn: `${srcSchemaFqn}.${source}`,
        s3Fqn: writeS3 ? `${s3SchemaFqn}.${target}` : "",
        rsFqn: writeRs ? `${rsSchemaFqn}.${target}` : "",
      };
    }),
  };
}
