// 模块 55 / 序 50 第二批 —— 数据源的长操作执行体:为 S3 数据源建 Athena 外部表(模块 42 P42.4 分析通道);
// 序 57 / B-129 第三批首条:JDBC 数据源「新建」的 provision 段(datasource-create,见文末)。
//
// 原路由(app/api/datasources/[id]/s3-external POST)的「主体」原样搬入:项目鉴权 / 读源行 / 类型校验 **留在路由**;
// 这里只做「introspect 出逻辑数据集 → 选数据集与列 → CREATE DATABASE + DROP + CREATE EXTERNAL TABLE(经 awaitTerminal 等 Athena 终态)→ 审计 → 回 data」。
// 🔴 为什么进长操作:三条 Athena DDL 各最多等 60 × 2s,实测大桶 introspect + 建表合计常超 60s 墙 ⇒ 504 而表已建成。
// 错误口径与接入前逐字一致(400 四种业务拒因 / 500「建外部表失败: …」)。
// 🔴 序 52 / B-124(2026-10-25):外部表建在**这条源所在区**的 Athena 工作组 / Glue 目录 —— 落点 = 行上的章(唯一读法
//   datasourceOwnerTarget,存量无章 = 主控区)经 resolveAthenaPlace 解析(非 home 取该区描述符的 athenaWorkgroup / datalakeBucket),
//   再整体交给 ensureExternalTable(place 必填)。原来只记了落点决策、建表却一律落主控区。响应多回 targetId / region,页面据此指路。

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
// B-129:建源 provision 段的四个外部步骤 + 失败时的三样清理,全部走 datasource-service 的既有唯一作者(与原路由同一组函数,调用序列不变)
import {
  createGlueConnection, deleteGlueConnection, deleteSecret, deleteSecurityGroup,
  detectNetwork, ensureGlueRole, isUserNetworkConfig, testConnection, userSpecifiedNetwork,
  type NetworkConfig, type UserNetworkConfig,
} from "@/lib/aws/datasource-service";
// 序 58 B-130:平台自建安全组的持久清理作业(入队即持久,泵按网卡事实收口)
import { enqueueSgCleanup } from "@/lib/datasource/sg-cleanup-job";
import { readSourceSchema } from "@/lib/datasource/schema-reader";
import { pushDataSourceToOpenMetadata } from "@/lib/openmetadata/om-push";
import { settleAfterConfigCheck } from "@/lib/datasource/reachability-probe";
import { placementForNewDataSource } from "@/lib/datasource/placement";
import { resolveDsPlace } from "@/lib/datasource/ds-place";
import type { DataSource } from "@/types/datasource";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { LongOpHttpError } from "@/lib/long-ops/store";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";
import { ensureExternalTable, S3_EXTERNAL_DB } from "@/lib/datasource-spi/object-store/athena-external";
import { resolveAthenaPlace } from "@/lib/athena/client";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";
// 序 31 二刀 ⑤:introspect 桶 / Athena DDL 都替这条源所在区做事 ⇒ 读到行就记落点决策(同步分支在原请求里跑,账本可用)
import { noteDatasourceRowPlace } from "@/lib/datasource/ds-place";

const USER_ID = "default-user";

const datasourceS3External: LongOpExecutor<"datasource-s3-external"> = async (params, ctx) => {
  const { datasourceId, dataset: wantDataset, columns: userColumns } = params;
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId } }));
  if (!ds) throw new LongOpHttpError(404, "数据源不存在");
  noteDatasourceRowPlace(ds);
  if (ds.type !== "s3") throw new LongOpHttpError(400, "仅 S3 数据源支持建 Athena 外部表");
  if (!isDataSourceType(ds.type)) throw new LongOpHttpError(400, `不支持的数据源类型: ${ds.type}`);
  const conn = ds.connection || {};
  const bucket = conn.bucket;
  if (!bucket) throw new LongOpHttpError(400, "S3 数据源缺少 bucket");
  try {
    // B-124:先把落点整体解析出来(该区的 region / 工作组 / 结果桶四样焊在一起);该区没就位 / 没有 Athena 工作组 ⇒ 当场拒,不回落主控区
    const place = await resolveAthenaPlace(datasourceOwnerTarget(ds));
    const provider = getProvider(ds.type);
    // introspect 出逻辑数据集(每个子前缀一个);选 dataset 指定的,或第一个。
    const datasets = await provider.introspect(toSourceRef({ type: ds.type, connection: conn }));
    if (datasets.length === 0) throw new LongOpHttpError(400, "该 S3 路径下未发现可建表的数据集(前缀为空或无权限)");
    const target = wantDataset ? datasets.find((item) => item.name === wantDataset) : datasets[0];
    if (!target) throw new LongOpHttpError(400, `未找到数据集: ${wantDataset}`);
    // 列:优先用用户在 UI 校正过的;否则用 introspect 推断的。
    const columns = Array.isArray(userColumns) && userColumns.length > 0 ? userColumns : target.columns;
    if (!columns || columns.length === 0) {
      throw new LongOpHttpError(400, "未能推断出列定义(CSV 需有表头,或请手动提供列)。Parquet/JSON 可在请求中带 columns。");
    }
    // location = 该数据集的 s3 路径(introspect meta 里已带),兜底用连接袋拼。
    const prefix = (conn.prefix || "").toString().replace(/^\/+/, "");
    const location = (target.meta?.location as string) || `s3://${bucket}/${prefix}`;
    const format = (target.meta?.format as string) || conn.format || "auto";
    const result = await ensureExternalTable(
      {
        table: target.name,
        location,
        format,
        hasHeader: conn.hasHeader === undefined ? true : !!conn.hasHeader,
        columns,
      },
      place
    );
    recordAudit(ctx.req, "datasource.s3-external", {
      resourceType: "datasource",
      resourceId: datasourceId,
      detail: { database: result.database, table: result.table, location, format, targetId: result.targetId, region: result.region },
    }).catch(() => {});
    return {
      data: {
        database: result.database,
        table: result.table,
        qualifiedName: `${result.database}.${result.table}`,
        location,
        format,
        columns,
        ddl: result.ddl,
        // 前端可直接用这条 SQL 走数据湖直查接口查数据(直查页按 ?scope=<targetId> 锚到同一个区)。
        sampleQuery: `SELECT * FROM ${S3_EXTERNAL_DB}.${result.table} LIMIT 100`,
        // B-124:表真落在哪个区(页面「去数据湖直查」据此定视角;审计同记)
        targetId: result.targetId,
        region: result.region,
      },
    };
  } catch (e: unknown) {
    if (e instanceof LongOpHttpError) throw e;
    throw new LongOpHttpError(500, `建外部表失败: ${String((e as Error)?.message || e).slice(0, 300)}`, { cause: e });
  }
};

// ── 序 57 / B-129:JDBC 数据源「新建」的 provision 段 ──────────────────────────────────────────────
//
// 【缺陷原形】第四十七轮 nap 首跑:主控区视角「新建数据源」点「完成」⇒ 页面等 60 秒 504,服务端却在第 66 秒把源建出来了
//   (CloudTrail:CreateSecret 后**空档 64 秒**才到 IAM GetRole,其后 CreateSecurityGroup / CreateConnection 各 1 秒)。
//   原路由把「建密钥 → 核 Glue 角色 → 探网段 / 建组 → 建 Glue 连接 → 落库」同步串在请求路径上,没有任何超时预算:
//   任何一跳停顿都撞 CloudFront 60 秒墙,而服务端照样做完 ⇒ 「报错了但又建出来了」,再点一次就建出重复的源(与 B-121 同类)。
// 【根治】① 本执行体接长操作框架:45 秒内完成 ⇒ 同步 201 逐字不变;否则 202 + 页面轮询「正在后台执行:新建数据源」,永不 504;
//   ② 对象租约 `datasource:create:<项目>:<名字>`:后台还在建时再点同名「完成」⇒ 409,不分叉、不重复建;
//   ③ 中途失败不留孤儿:已建的 Glue 连接 / 平台安全组 / 密钥按建立的逆序清掉(纪律 7),再按原口径回 500「创建数据源失败: …」。
// 【主体原样搬入】路由只保留鉴权 / 入参校验 / 落点解析 / **建密钥**(口令不能落任务行,所以密钥必须在请求里建好,只把 ARN 交进来);
//   这里从 Glue 角色核验开始,到落库 + 两段 fire-and-forget 收口(源表进 OM 目录 / 配置核对 ⇒ 连通性结论写 status,B-73)为止,
//   AWS 调用序列与原路由逐字相同(create-network-assembly.test 钉住)。

/** 失败时按逆序清理已建产物;每一步 best-effort、只记日志(清理失败不能盖住真正的建源错误)。 */
async function cleanupProvisioned(args: {
  datasourceId: string; targetId: string; region: string; secretArn: string;
  glueConnectionName?: string; network?: NetworkConfig | UserNetworkConfig;
}): Promise<void> {
  const { datasourceId, region } = args;
  if (args.glueConnectionName) {
    await deleteGlueConnection(args.glueConnectionName, region).catch((e: unknown) => {
      logger.warn("datasource.create.cleanup", { datasourceId, step: "glue-connection", error: String((e as Error)?.message || e).slice(0, 200) });
    });
  }
  // 平台自建的组才删(用户指定的组一个都不碰);刚建的连接网卡若还没释放 ⇒ 序 58 B-130:登记持久清理作业(泵按网卡事实收口),
  //   不再靠进程内存里的定时重试(ECS 滚动即丢、耗尽即永久遗留)。入队失败只记日志:这里已经在失败路径上,不能盖住真正的建源错误。
  if (args.network && !isUserNetworkConfig(args.network)) {
    const sgId = args.network.securityGroupId;
    const outcome = await deleteSecurityGroup(sgId, region, datasourceId).catch(() => "failed" as const);
    if (outcome === "failed-dependency" || outcome === "failed") {
      await enqueueSgCleanup({ sgId, region, targetId: args.targetId, datasourceId, createdBy: "system:datasource-create-cleanup" })
        .then((r) => logger.info("datasource.create.cleanup", { datasourceId, step: "security-group", outcome: "scheduled", syncOutcome: outcome, jobId: r.jobId }))
        .catch((e: unknown) => logger.warn("datasource.create.cleanup", { datasourceId, step: "security-group", outcome: "enqueue-failed", syncOutcome: outcome, error: String((e as Error)?.message || e).slice(0, 200) }));
    } else if (outcome !== "deleted" && outcome !== "gone") {
      logger.warn("datasource.create.cleanup", { datasourceId, step: "security-group", outcome });
    }
  }
  await deleteSecret(args.secretArn);
}

const datasourceCreate: LongOpExecutor<"datasource-create"> = async (params, ctx) => {
  const { datasourceId, projectId, name, type, host, port, database, username, secretArn, jdbcParams, probeVia, env, tags } = params;
  // 落点在路由里已解析过一次(解析失败 400 什么都不建);这里再解析一次拿该区的网络事实 / home 判定(任务可能被另一次请求接管执行)
  const dsPlace = await resolveDsPlace(params.targetId);
  let glueConnectionName: string | undefined;
  let networkConfig: NetworkConfig | UserNetworkConfig | undefined;
  try {
    // Step 2: DS-02 — 主控区的共享 Glue 角色由 CDK 平台栈建好,这里只核一次并缓存(B-129 ②);非主控区用 per-target 栈的角色,不在这里核
    if (dsPlace.home) {
      try {
        await ensureGlueRole();
      } catch (e: unknown) {
        throw new LongOpHttpError(503, `创建数据源失败: 主控区 Glue 作业角色未就位(${String((e as Error)?.message || e).slice(0, 200)}),请稍后重试`, { code: "UPSTREAM_ERROR", cause: e });
      }
    }

    // Step 3: DS-03 — 网络接入:用户指定了子网 / 组 ⇒ 只探测不建组(B-54);否则探测 + 新建平台 bgp-ds-* 组(老路径,调用序列逐字不变)
    networkConfig = params.network
      ? await userSpecifiedNetwork(host, dsPlace, { subnetId: params.network.subnetId, securityGroupIds: params.network.securityGroupIds, availabilityZone: params.network.availabilityZone })
      : await detectNetwork(host, type, datasourceId, dsPlace);

    // Step 4: DS-01 — Glue 连接建在落点那个区
    glueConnectionName = await createGlueConnection(datasourceId, type, host, port, database, secretArn, networkConfig, dsPlace.region, jdbcParams || undefined);

    // Step 5: 落库(不存口令)
    const now = new Date().toISOString();
    const item = {
      userId: USER_ID,
      datasourceId,
      projectId,
      ...placementForNewDataSource(dsPlace.targetId),
      createdBy: ctx.identity.username,
      createdBySub: ctx.identity.sub,
      name,
      type,
      host,
      port,
      database,
      username,
      ...(jdbcParams ? { jdbcParams } : {}),
      status: "testing" as const,
      env: env || "",
      tags: tags || [],
      ...(probeVia ? { probeVia } : {}),
      secretArn,
      glueConnectionName,
      networkConfig: {
        vpcId: networkConfig.vpcId,
        subnetId: networkConfig.subnetId,
        // B-133 第二刀:可用区也落行(此前从不落 ⇒ 自愈 / 改网络按源行重建的 Glue 连接没有 AZ,作业起不来);写连接的作者仍按子网事实核
        ...(networkConfig.availabilityZone ? { availabilityZone: networkConfig.availabilityZone } : {}),
        securityGroupId: networkConfig.securityGroupId,
        ...(isUserNetworkConfig(networkConfig) ? { securityGroupIds: [...networkConfig.securityGroupIds] } : {}),
        isRds: networkConfig.isRds,
        rdsInstanceId: networkConfig.rdsInstanceId,
      },
      createdAt: now,
      updatedAt: now,
    };
    await docClient.send(new PutCommand({ TableName: TABLES.DATASOURCES, Item: item }));

    recordAudit(ctx.req, "datasource.create", {
      resourceType: "datasource",
      resourceId: datasourceId,
      detail: { name, type, host, database },
    }).catch(() => {});

    // 源表进该源落点的 OM service(fire-and-forget,永不阻塞建源)
    (async () => {
      const tables = await readSourceSchema({ type, host, port, database, username, secretArn });
      await pushDataSourceToOpenMetadata({ database }, tables, dsPlace.targetId);
    })().catch(() => {});

    // Step 6: DS-16 — 配置核对(落点那个区的 Glue)⇒ 连通性结论写 status(B-73;与「检测」同一作者),不阻塞响应
    testConnection(glueConnectionName, dsPlace.region)
      .then((result) => settleAfterConfigCheck(item as unknown as DataSource, result))
      .catch((e) => console.warn(`[datasource] ${datasourceId} 建源后连通性收口失败:${String(e?.message || e).slice(0, 200)}`));

    return {
      data: {
        ...item,
        provisionedResources: {
          secretArn,
          glueConnectionName,
          securityGroupId: networkConfig.securityGroupId,
          vpcId: networkConfig.vpcId,
          subnetId: networkConfig.subnetId,
        },
      },
      resultStatus: 201,
    };
  } catch (e: unknown) {
    await cleanupProvisioned({ datasourceId, targetId: dsPlace.targetId, region: dsPlace.region, secretArn, glueConnectionName, network: networkConfig });
    if (e instanceof LongOpHttpError) throw e;
    throw new LongOpHttpError(500, `创建数据源失败: ${String((e as Error)?.message || e)}`, { cause: e });
  }
};

export type DatasourceLongOpKind = "datasource-s3-external" | "datasource-create";
export const DATASOURCE_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, DatasourceLongOpKind> = {
  "datasource-s3-external": datasourceS3External,
  "datasource-create": datasourceCreate,
};
