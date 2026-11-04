export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { createSecret, deleteSecret, parseUserDsNetwork } from "@/lib/aws/datasource-service";
import { apiOk, apiError } from "@/lib/api-response";
// 序 38 B-70:探测方式闭合清单(表单 / 路由同一份)
import { DS_PROBE_VIA, type DsProbeVia, type DataSource } from "@/types/datasource";
import { settleGlueProbeRows } from "@/lib/datasource/glue-probe-settle";
// 序 60 B-132:状态回写走唯一作者(条件写;源已删即丢弃,不再造幽灵行)
import { patchDataSourceRow } from "@/lib/datasource/ds-patch";
import { recordAudit } from "@/lib/audit";
// 序 57 / B-129:JDBC 建源的 provision 段(核 Glue 角色 → 探网段 / 建组 → 建 Glue 连接 → 落库 → 收口)改经模块 55 长操作框架 ——
//   原来同步串在请求路径上、没有超时预算,一跳停顿(第四十七轮实测 IAM GetRole 前空档 64 秒)就撞 CloudFront 60 秒墙 504,
//   而服务端照样建出 ⇒ 「报错了但又建出来了」、再点重复建。现在 45 秒内 201 逐字不变,否则 202 + 页面轮询「正在后台执行:新建数据源」;
//   对象租约 `datasource:create:<项目>:<名字>` 让后台还在建时再点同名「完成」⇒ 409。主体在 lib/datasource/long-ops.ts(datasource-create)。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";
import { requireProject, projectFilter } from "@/lib/projects/guard";
// @kf-batch 50-WP4bis-p1-scope —— 执行范围(50 SPEC §2.6;WP-4bis 阶段 1)
import { requireScope, scopeFilter } from "@/lib/exec-env/scope";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { parseJdbcParams } from "@/lib/datasource-spi/jdbc/jdbc-params";
import { toSourceRef } from "@/lib/datasource-spi/normalize";
// @kf-batch 50-W3f-T0-T3 —— 新建数据源盖落点(ownerTargetId),两条建源路径同源
import { placementForNewDataSource } from "@/lib/datasource/placement";
// @kf-batch 50-WP4quater-reads(工单 SC-2)—— 🔴 建源落点。用户 2026-09-10:「所有的任务都要创建在
// 当前区域,不能只是创建在主控区,没意义…不然也是白干了。」建源是这条链的第一环:同步任务的落点
// 由它引用的数据源的 `ownerTargetId` 派生,所以「源只能建在主控区」= 同步任务只能落主控区。
import { resolveDsPlace, type DsPlaceResolved } from "@/lib/datasource/ds-place";
import { ulid } from "ulid";

// Physical DynamoDB partition value (kept constant for zero-migration; module 13). Logical
// tenancy lives in the projectId attribute + membership/RBAC, not in this partition key.
const USER_ID = "default-user";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireProject(req, "viewer");
    if (ctx instanceof NextResponse) return ctx;
    // @kf-batch 50-WP4bis-p1-scope —— 执行范围。🔴 只认 URL 的 `?scope=`;非法/不存在/无权一律 4xx,
    // **绝不回落 home 或 global**(回落会让用户以为在看一个区、其实在看全部)。
    const scope = await requireScope(req, ctx.projectId);
    if (scope instanceof NextResponse) return scope;

    const p = req.nextUrl.searchParams;
    const name = p.get("name") || "";
    const type = p.get("type") || "";
    const status = p.get("status") || "";
    const hasGlue = p.get("hasGlue") || "";
    const hasSecret = p.get("hasSecret") || "";

    const pf = projectFilter(ctx.projectId);
    const filterParts: string[] = ["userId = :uid", pf.clause];
    const attrNames: Record<string, string> = {};
    const attrValues: Record<string, any> = { ":uid": USER_ID, ...pf.values };

    if (name) { filterParts.push("contains(#nm, :nm)"); attrNames["#nm"] = "name"; attrValues[":nm"] = name; }
    if (type) { filterParts.push("#tp = :tp"); attrNames["#tp"] = "type"; attrValues[":tp"] = type; }
    if (status) { filterParts.push("#st = :st"); attrNames["#st"] = "status"; attrValues[":st"] = status; }
    if (hasGlue === "true") { filterParts.push("attribute_exists(glueConnectionName)"); }
    else if (hasGlue === "false") { filterParts.push("attribute_not_exists(glueConnectionName)"); }
    if (hasSecret === "true") { filterParts.push("attribute_exists(secretArn)"); }
    else if (hasSecret === "false") { filterParts.push("attribute_not_exists(secretArn)"); }

    // @kf-batch 50-WP4bis-p1-scope —— A 类(标量章 `ownerTargetId`)⇒ 直接下推 DDB。
    // 🔴 `global` 时 `scopeFilter` 回 `null` ⇒ 表达式与改动前**逐字节相同**(回滚点)。
    // ⚠️ 订正(2026-09-15,WP-23 W23-4):这条注释原来写「一期建源只发生在主控区(恒盖 home)」——
    //    **已过时**。`placementForNewDataSource(targetId)` 现在由 `resolveDsPlace()` 从「顶栏视角 / 显式
    //    `body.targetId`」得到落点(用户 2026-09-10 拍板「任务必须能建在当前区」),非 home 视角建的源
    //    盖的是那个区的章、Glue 连接也建在那个区 ⇒ 非 home 视角下这张表**不再必然为空**。
    //    空态仍由 `ScopeEmptyHint` 说清「主控区有 N 个」并给切回入口(那一段没变)。
    const sf = scopeFilter(scope, "datasource");
    if (sf) {
      filterParts.push(sf.clause);
      Object.assign(attrNames, sf.names);
      Object.assign(attrValues, sf.values);
    }

    const { Items = [] } = await docClient.send(new ScanCommand({
      TableName: TABLES.DATASOURCES,
      FilterExpression: filterParts.join(" AND "),
      ...(Object.keys(attrNames).length > 0 ? { ExpressionAttributeNames: attrNames } : {}),
      ExpressionAttributeValues: attrValues,
    }));
    // 序 38 B-70:「经 Glue 连接验证中」的行读到就推进到结论(页面不再轮询时也能看到结果);非 testing 行零外部调用
    return apiOk(await settleGlueProbeRows(Items as DataSource[]));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();
  const { name, type, host, port, database, username, password, env, tags, rdsSecretArn } = body;

  if (!name || !type) return apiError("缺少必填字段: name, type");
  // @kf-batch 44-jdbc-params —— 附加 JDBC 连接参数:形态不合法 ⇒ 400 什么都不建;落库与进 Glue 连接的都是归一化后的 `k=v&k=v`
  const jp = parseJdbcParams(body.jdbcParams);
  if (!jp.ok) return apiError(jp.error, 400, { code: "VALIDATION_FAILED" });
  const jdbcParams = jp.normalized;
  // 序 38 B-70:探测方式(闭合清单;不传 = auto)
  const probeVia: DsProbeVia | undefined = body.probeVia === undefined || body.probeVia === null || body.probeVia === "" ? undefined : body.probeVia;
  if (probeVia !== undefined && !(DS_PROBE_VIA as readonly string[]).includes(String(probeVia))) {
    return apiError(`探测方式不合法:${JSON.stringify(body.probeVia)}(可选:${DS_PROBE_VIA.join(" / ")})`, 400, { code: "VALIDATION_FAILED" });
  }

  // 模块42 §10.5:按范式分流。stream(Kinesis/后续 MSK)/object-store 等非 JDBC 源不走
  //  host/port/database + Glue Connection + 存密钥,而是各自连接袋 + provider.validateConfig。
  //  JDBC 路径逐字保持不变(向后兼容,零回归)。paradigm 由已注册 provider 的 capabilities 驱动。
  const provider = isDataSourceType(type) ? getProvider(type) : null;
  const isJdbc = !provider || provider.capabilities.needsGlueConnection; // 未知类型按旧 JDBC 路径(保底兼容)
  if (isJdbc) {
    // JDBC 路径:必填 host/port/database（原逻辑,逐字不变）。
    if (!host || !port || !database) {
      return apiError("缺少必填字段: name, type, host, port, database");
    }
    if (!rdsSecretArn && (!username || !password)) {
      return apiError("缺少必填字段: username, password (或提供 rdsSecretArn)");
    }
  } else {
    // 非 JDBC 路径:用 provider 校验连接袋(如 Kinesis 的 streamName)。
    const conn = (body.connection && typeof body.connection === "object") ? body.connection : {};
    const v = provider!.validateConfig(conn);
    if (!v.ok) return apiError(`连接配置无效: ${v.errors.join("；")}`);
    // 🔴 非 JDBC 源也要先解析落点(解析失败 400 什么都不建)
    // @kf-batch 50-WP27-9cap-matrix —— 🔴🔴 **顺序从「先 provision 后解析落点」改成「先解析后 provision」**,
    //   两个缺陷一起修:
    //   ① 上面那句注释「解析失败 400 什么都不建」**对 provision 型源本来是假的**:流已经在 AWS 里建好了,
    //      请求才 400 ⇒ 账号里留一条没人管的、在**计费**的 Kinesis 流,而平台侧没有任何记录;
    //   ② 🔴 更要紧的是 region:`provision` 用的是 `conn.region`(**前端随便传、缺省回落部署区**),
    //      而这条源的**章**由 `resolveDsPlace(targetId)` 决定。两者从不交叉核对 ⇒ 可以造出
    //      「章说 us-west-2、流其实在 us-east-1」的源。后续实时作业的跨区检查看的是 `ownerTargetId`
    //      (它是 usw2,检查通过),于是**在 usw2 跑的作业去读 us-east-1 的流** —— 跨区取数,
    //      而且一切看起来正常。⇒ 物理区**由章派生**(单一真值源),显式传了不一致的就当场拒。
    let nonJdbcPlace: DsPlaceResolved;
    try {
      nonJdbcPlace = await resolveDsPlace(requestedTargetId(body.targetId, "新建数据源"));
    } catch (e: any) {
      const pr = placeErrorResponse(e);
      if (pr) return pr;
      return apiError(String(e?.message || e), 400, { code: "VALIDATION_FAILED" });
    }
    if (typeof conn.region === "string" && conn.region.trim() && conn.region.trim() !== nonJdbcPlace.region) {
      return apiError(
        `这条数据源的章是 ${nonJdbcPlace.targetId}(${nonJdbcPlace.region}),而连接里写的 region 是 ` +
          `${conn.region}。🔴 平台不接受「章与资源不在同一个区」——那会让在 ${nonJdbcPlace.region} 跑的作业` +
          `去另一个区取数,而链路上每一步都不会报错。` +
          `⇒ 要在 ${conn.region} 建源,请把顶栏切到那个区(或显式传那个区的 targetId)。`,
        400,
        { code: "VALIDATION_FAILED" }
      );
    }
    // 章决定物理区:provider 的 `provision` / `introspect` / `ping` 全都读连接袋里的 region。
    const placedConn = { ...conn, region: nonJdbcPlace.region };

    // §10.4 按需新建源:body.provision=true 且 provider 支持 → 先建底层资源(如建 Kinesis 流),
    //   再用其返回的连接袋落库。🔴 前端已在页面显式确认(含成本告知)后才带 provision=true。
    let finalConn = placedConn;
    let provisionNote: string | undefined;
    if (body.provision === true) {
      if (!provider!.capabilities.canProvision || !provider!.provision) {
        return apiError(`数据源类型 ${type} 不支持新建底层资源`, 400);
      }
      try {
        const r = await provider!.provision(placedConn);
        finalConn = { ...placedConn, ...r.connection }; // provision 回填的连接标识(如确认的 streamName/region)优先
        provisionNote = r.note;
      } catch (e: any) {
        return apiError(`新建资源失败: ${String(e?.message || e).slice(0, 200)}`, 500);
      }
    }
    return createNonJdbcSource(req, ctx, { name, type, env, tags }, finalConn, provisionNote, nonJdbcPlace);
    // 注:凭证(如 MSK SASL/SCRAM 的账密)由 createNonJdbcSource 按 provider.buildSecretPayload 决定是否建 secret,
    //     并【不写进 connection 袋落库】(密钥不入库红线)——见其内部实现。
  }

  // @kf-batch 37-B54-ds-user-sg —— 用户网络在**建任何 AWS 资源之前**解析;畸形 ⇒ 400 什么都不建。
  const userNet = parseUserDsNetwork(body?.network);
  if (userNet.kind === "invalid") return apiError(userNet.reason, 400, { code: "VALIDATION_FAILED" });

  const datasourceId = ulid();

  // 🔴 落点在**建任何 AWS 资源之前**解析:解析失败就 400 什么都不建,
  //    否则会留下「密钥建在 A 区、安全组建在 B 区」的半截状态(比直接失败难清理得多)。
  let dsPlace: DsPlaceResolved;
  try {
    dsPlace = await resolveDsPlace(requestedTargetId(body.targetId, "新建数据源"));
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(String(e?.message || e), 400, { code: "VALIDATION_FAILED" });
  }

  // Step 1: DS-04 — 密钥**在请求里同步建**(一次 CreateSecret,实测 1 秒内):口令不能落长操作任务行,所以 provision 段只拿 ARN。
  let resolvedUsername = username || "admin";
  let secretArn: string;
  try {
    if (rdsSecretArn) {
      // 序 31 三刀 IAM 侧(2026-10-21):RDS 实例的托管主密钥是**账号自有**密钥(`rds!db-…` / 演示库 `BgpRdsStack…`),不在数据面角色的
      //   实名读清单里;把账密复制进平台的 bgp/datasource/<id> 是建源时的一次性控制面动作 ⇒ 走控制面轴读(理由见 getAccountSecretViaControlPlane)。
      const { getAccountSecretViaControlPlane } = await import("@/lib/datasource-spi/secrets");
      const rdsSecret = await getAccountSecretViaControlPlane(rdsSecretArn);
      resolvedUsername = rdsSecret.username;
      // 🔴 凭证建在**落点那个区**:建在主控区而作业在别区跑,Glue 连接读不到密钥(读侧按 ARN 派生 region)
      secretArn = await createSecret(datasourceId, rdsSecret.username, rdsSecret.password, dsPlace.region);
    } else {
      secretArn = await createSecret(datasourceId, username, password, dsPlace.region);
    }
  } catch (e: any) {
    return apiError(`创建数据源失败: ${e.message}`, 500);
  }

  // Step 2–6(核 Glue 角色 → 网络接入 → Glue 连接 → 落库 → 收口)在执行体 datasource-create 里,调用序列与改动前逐字相同。
  try {
    const result = await submitLongOp(
      {
        kind: "datasource-create",
        params: {
          datasourceId,
          projectId: ctx.projectId,
          targetId: dsPlace.targetId,
          name,
          type,
          host,
          port,
          database,
          username: resolvedUsername,
          secretArn,
          // @kf-batch 44-jdbc-params —— 不填 ⇒ 不写键(行形态与改动前相同)
          ...(jdbcParams ? { jdbcParams } : {}),
          // 序 38 B-70:源在自有网络时用户可声明只经 Glue 连接探测 / 发现表(不传 ⇒ 不写键)
          ...(probeVia ? { probeVia } : {}),
          ...(env ? { env } : {}),
          ...(Array.isArray(tags) ? { tags } : {}),
          // @kf-batch 37-B54-ds-user-sg —— 用户指定了子网 + 组 ⇒ 平台不建组、用户的组全部进 Glue 连接;没指定 ⇒ 不写键 = 老路径自动探测
          ...(userNet.kind === "user"
            ? { network: { subnetId: userNet.net.subnetId, securityGroupIds: userNet.net.securityGroupIds, ...(userNet.net.availabilityZone ? { availabilityZone: userNet.net.availabilityZone } : {}) } }
            : {}),
        },
        correlationId: getCorrelationId(req),
      },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    // 执行体没跑到(同名建源的租约被占 ⇒ 409 / 任务表写不进)或在等待预算内失败(执行体已清理自己的产物):
    //   上面建的密钥都不能留(纪律 7 不留孤儿;重复删幂等)。
    await deleteSecret(secretArn);
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(`创建数据源失败: ${e.message}`, 500);
  }
}

// 模块42 §10.5 — 非 JDBC 源(stream/object-store,凭证=iam-role)建源:
//  不存密钥、不建 Glue Connection、不 detectNetwork;连接信息进 connection 袋;
//  用 provider.testConnection 定初始 status(可达=active)。与 JDBC 路径解耦,零回归。
async function createNonJdbcSource(
  req: NextRequest,
  ctx: { projectId: string; identity: { username: string; sub: string } },
  meta: { name: string; type: string; env?: string; tags?: string[] },
  connection: Record<string, any>,
  provisionNote?: string,
  // @kf-batch 50-WP4quater-reads(工单 SC-2)—— 非 JDBC 源同样按落点建(凭证与章)
  // L4 过渡:语义是缺省回落主控区(静默默认值类),序 6 再按落点改
  dsPlace: DsPlaceResolved = { targetId: "tgt_home", region: homeRegion(), home: true },
) {
  const datasourceId = ulid();
  const now = new Date().toISOString();
  const provider = getProvider(meta.type as any);
  try {
    // 🔴 凭证不入库:若 provider 声明了 buildSecretPayload 且本次连接确需密钥(如 MSK SASL/SCRAM),
    //    把账密建成 Secrets Manager secret、只存 secretArn;并从落库的 connection 袋里【剥离】username/password。
    //    iam-role 类源(Kinesis / MSK-IAM)buildSecretPayload 返回 undefined → 无 secret,行为不变(零回归)。
    let secretArn: string | undefined;
    let credentialKind = provider.capabilities.credentialKind;
    const conn = { ...connection };
    const secretPayload = provider.buildSecretPayload ? provider.buildSecretPayload(conn) : undefined;
    if (secretPayload) {
      const parsed = JSON.parse(secretPayload); // {username,password}
      secretArn = await createSecret(datasourceId, parsed.username, parsed.password, dsPlace.region);
      credentialKind = "sasl-scram"; // 本连接确实用了账密(区别于同 provider 的 iam 认证)
    } else {
      credentialKind = "iam-role"; // 无密钥(iam 认证 / Kinesis)
    }
    // 无论如何都不把明文账密留在 connection 袋里落库。
    delete (conn as any).username;
    delete (conn as any).password;
    const item: any = {
      userId: USER_ID,
      datasourceId,
      projectId: ctx.projectId,
      ...placementForNewDataSource(dsPlace.targetId),
      createdBy: ctx.identity.username,
      createdBySub: ctx.identity.sub,
      name: meta.name,
      type: meta.type,
      connection: conn, // §5:非 JDBC 源写属性袋(不写扁平 host/port/database;已剥离账密)
      credentialKind,
      paradigm: provider.capabilities.paradigm,
      ...(secretArn ? { secretArn } : {}), // SASL/SCRAM:凭证引用(iam/Kinesis 无)
      status: "testing" as const,
      env: meta.env || "",
      tags: meta.tags || [],
      ...(provisionNote ? { provisionNote } : {}), // 新建资源留痕(如"已新建流 X")
      createdAt: now,
      updatedAt: now,
    };
    await docClient.send(new PutCommand({ TableName: TABLES.DATASOURCES, Item: item }));

    recordAudit(req, "datasource.create", {
      resourceType: "datasource",
      resourceId: datasourceId,
      detail: { name: meta.name, type: meta.type },
    }).catch(() => {});

    // 异步真连测试(不阻塞响应):可达→active,否则 error。序 60 B-132:经 patchDataSourceRow 条件写 —— 源在收口前被删 ⇒ 结论丢弃,不造幽灵行。
    provider.testConnection(toSourceRef(item)).then(async (result) => {
      await patchDataSourceRow(datasourceId, {
        status: result.success ? "active" : "error",
        testResult: { ...result, testedAt: new Date().toISOString() },
      });
    }).catch(() => {});

    return apiOk(item, 201);
  } catch (e: any) {
    return apiError(`创建数据源失败: ${e.message}`, 500);
  }
}
