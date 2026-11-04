export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
import { pickEditableDatasourceFields } from "@/lib/datasources/editable-fields";
import { parseJdbcParams } from "@/lib/datasource-spi/jdbc/jdbc-params";
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— 存量源的章:无章 = 主控区(唯一作者)
import { targetOfStamp } from "@/lib/exec-env/target-id";
import { GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { deleteSecret, deleteGlueConnection, deleteSecurityGroup, isUserNetworkConfig, getSecret, updateSecret, updateGlueConnectionEndpoint, updateGlueConnectionNetwork } from "@/lib/aws/datasource-service";
// @kf-batch 50-WP4quater-reads(工单 SC-2)—— 🔴 改网络 / 删源都必须打**这条源自己那个区**:
// 打主控区的后果是「行删了、那个区的 Glue 连接与安全组留着」——残留资源占着 SG,
// 后面删整个执行环境时会被卡住(记忆 `retain-orphans-and-dryrun-false-green` 就是这个形状)。
import { resolveDsPlace, noteDatasourceRowPlace } from "@/lib/datasource/ds-place";
// 序 38 B-70:探测方式闭合清单(表单 / 路由同一份);删源连带撤发现作业
import { DS_PROBE_VIA, type DataSource } from "@/types/datasource";
import { teardownDiscoveryArtifacts } from "@/lib/datasource/glue-reach";
import { settleGlueProbeRows } from "@/lib/datasource/glue-probe-settle";
// 序 59 B-131:删源前读引用清单(同步 / 实时任务),非空 ⇒ 409 逐条点名;读不到 ⇒ 抛,不当 0
import { listDatasourceReferences, describeDatasourceReferences } from "@/lib/datasource/references";
// 序 58 B-130:平台自建安全组的持久清理作业(入队在动任何资源之前;泵按网卡事实收口)
import { enqueueSgCleanup } from "@/lib/datasource/sg-cleanup-job";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
// 模块 55 / 序 50 第二批 —— 对象租约 `datasource:<id>`:为这条源建 Athena 外部表(长操作 datasource-s3-external)进行中,编辑 / 删除 ⇒ 409
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
    );
    if (!Item) return apiError("数据源不存在", 404);
    const guard = await guardResourceAccess(req, Item, "viewer");
    if (guard instanceof NextResponse) return guard;
    // 序 38 B-70:「经 Glue 连接验证中」的行读到就推进到结论;推进失败不影响读取
    const row = await settleGlueProbeRows([Item as DataSource]);
    return apiOk(row[0]);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const raw = await req.json();
    // @kf-batch 42-ux-feedback —— 🔴 只认闭合清单里的可编辑字段(lib/datasources/editable-fields.ts 单一作者)。
    //   2026-10-15 …7698 页面复现:编辑弹窗把整条记录原样 PUT 回来(datasourceId / userId / updatedAt / status / secretArn …),
    //   下面的 `SET` 把它们全拼进去又另加 `#upd = :now` ⇒ DynamoDB「Two document paths overlap … [updatedAt]」500,改个名字都报错。
    //   不在清单的键一律丢弃并记一行日志(便于发现新的客户端漏网字段),不把记录回显当成写意图。
    const { picked, dropped } = pickEditableDatasourceFields(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
    const body: any = picked;
    if (dropped.length) console.warn(`[datasources:PUT] 丢弃不可编辑字段 ${params.id}: ${dropped.join(",")}`);

    // Load current item first to enforce project access (and to update the secret).
    const { Item: current } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
    );
    if (!current) return apiError("数据源不存在", 404);
    const guard = await guardResourceAccess(req, current, "editor");
    if (guard instanceof NextResponse) return guard;
    const busy = await resourceBusyResponse([resourceKey("datasource", params.id)]);
    if (busy) return busy;

    // @kf-batch 42-B83-ds-edit-sync —— 🔴 改了连接要素(type / host / port / database)或登录名 / 口令,先同步到**这条源自己那个区**的
    //   Glue 连接(JDBC URL · USERNAME · PASSWORD)与 secret,再落库;任一步失败 ⇒ 502 且记录不改(落库了而 Glue 还指旧 host = 页面说「已更新」实际没同步)。
    //   原来只有改密码才写 secret、改 host 只落库(台账 B-83):同步作业 / 发现作业 / 探测走的 Glue 连接仍指着旧库;只改登录名则连 secret 都不动。
    const cur = current as Record<string, any>;
    // 序 31 二刀 ⑤:读旧凭证(getSecret,区来自 ARN)发生在下面的 resolveDsPlace 之前 ⇒ 先按行上的章记一笔落点决策
    noteDatasourceRowPlace(cur);
    // @kf-batch 44-jdbc-params —— 附加 JDBC 参数:形态不合法 ⇒ 400 记录不改;落库归一化形态;空串 = 清空。变了与改 host 同列(Glue 连接的 URL 要跟着变)。
    if (body.jdbcParams !== undefined) {
      const jp = parseJdbcParams(body.jdbcParams);
      if (!jp.ok) return apiError(jp.error, 400, { code: "VALIDATION_FAILED" });
      body.jdbcParams = jp.normalized;
    }
    // 连接袋里也可能被客户端塞一个 jdbcParams(readConnection 优先读袋):同样过校验,不许把不合法参数落库留给生成脚本时才炸
    if (body.connection && typeof body.connection === "object" && (body.connection as Record<string, unknown>).jdbcParams !== undefined) {
      const jp2 = parseJdbcParams((body.connection as Record<string, unknown>).jdbcParams);
      if (!jp2.ok) return apiError(jp2.error, 400, { code: "VALIDATION_FAILED" });
      (body.connection as Record<string, unknown>).jdbcParams = jp2.normalized;
    }
    const changed = (k: string) => body[k] !== undefined && String(body[k]) !== String(cur[k] ?? "");
    const endpointChanged = ["type", "host", "port", "database", "jdbcParams"].some(changed);
    const passwordGiven = typeof body.password === "string" && body.password.length > 0;
    let creds: { username: string; password: string } | undefined;
    if ((changed("username") || passwordGiven) && cur.secretArn) {
      // 只改登录名 ⇒ 口令沿用 secret 里现有的(读不到就如实 502,不许写一个空口令进去)
      let password = passwordGiven ? String(body.password) : "";
      if (!passwordGiven) {
        try {
          password = String((await getSecret(cur.secretArn)).password ?? "");
        } catch (e: any) {
          return apiError(`读取现有凭证失败,记录未改:${e?.message || e}`, 502, { code: "UPSTREAM_ERROR" });
        }
        if (!password) return apiError("现有凭证里没有口令,改登录名需同时提供新口令", 409, { code: "CONFLICT" });
      }
      creds = { username: String(body.username ?? cur.username ?? ""), password };
    }
    let glueSynced = false;
    if ((endpointChanged || creds) && cur.glueConnectionName) {
      try {
        const dsRegion = (await resolveDsPlace(targetOfStamp(cur.ownerTargetId))).region;
        await updateGlueConnectionEndpoint(cur.glueConnectionName, {
          type: String(body.type ?? cur.type ?? ""),
          host: String(body.host ?? cur.host ?? ""),
          port: Number(body.port ?? cur.port ?? 0),
          database: String(body.database ?? cur.database ?? ""),
          jdbcParams: String(body.jdbcParams ?? cur.jdbcParams ?? "") || undefined,
          ...(creds ? { username: creds.username, password: creds.password } : {}),
        }, dsRegion);
        glueSynced = true;
      } catch (e: any) {
        return apiError(`同步 Glue 连接失败,记录未改:${e?.message || e}`, 502, { code: "UPSTREAM_ERROR" });
      }
    }
    if (creds) {
      try {
        await updateSecret(cur.secretArn, creds.username, creds.password);
      } catch (e: any) {
        return apiError(`更新凭证失败,记录未改(Glue 连接已换成新连接信息):${e?.message || e}`, 502, { code: "UPSTREAM_ERROR" });
      }
    }
    delete body.password; // Don't store in DynamoDB

    // Tenancy attributes are immutable from this endpoint.
    delete body.userId;
    delete body.projectId;
    delete body.createdBy;
    delete body.createdBySub;
    // @kf-batch 50-W3f-T0-T3 —— 落点(ownerTargetId)同列不可变:本刀只落字段与迁移,不接线;
    // 让客户端能随手 PUT 一个别的 target 进来 = 在 O4 定义授权动作之前就开了改落点的口子。
    delete body.ownerTargetId;
    // 序 38 B-70:探测结果 / 发现作业状态 / 发现结果只由服务端写;探测方式按闭合清单校验
    delete body.heartbeat;
    delete body.discovery;
    delete body.discoveredSchema;
    if (body.probeVia !== undefined && body.probeVia !== null && body.probeVia !== "" && !(DS_PROBE_VIA as readonly string[]).includes(String(body.probeVia))) {
      return apiError(`探测方式不合法:${JSON.stringify(body.probeVia)}(可选:${DS_PROBE_VIA.join(" / ")})`, 400, { code: "VALIDATION_FAILED" });
    }
    if (body.probeVia === null || body.probeVia === "") body.probeVia = "auto";

    // 网络接入更新(只改 Glue 连接的子网/SG,不碰连接串/凭证)——解决数据源网络自动探测后无法调整的痛点。
    // body.network = { subnetId, securityGroupIds[], availabilityZone? };落库为 networkConfig。
    if (body.network && (current as any).glueConnectionName) {
      const net = body.network as { subnetId: string; securityGroupIds: string[]; availabilityZone?: string };
      if (!net.subnetId || !Array.isArray(net.securityGroupIds) || net.securityGroupIds.length === 0) {
        return apiError("网络配置需至少一个子网 + 一个安全组");
      }
      const dsRegion = (await resolveDsPlace(targetOfStamp((current as any)?.ownerTargetId))).region;
      await updateGlueConnectionNetwork((current as any).glueConnectionName, net, dsRegion);
      const prevNc = (current as any).networkConfig || {};
      body.networkConfig = {
        ...prevNc,
        subnetId: net.subnetId,
        securityGroupId: net.securityGroupIds[0],
        securityGroupIds: net.securityGroupIds,
        ...(net.availabilityZone ? { availabilityZone: net.availabilityZone } : {}),
      };
      delete body.network;
    }

    const fields = Object.keys(body);
    // 只改口令 / 只同步了凭证与 Glue 连接 ⇒ 没有可落库字段,但这次编辑**做了事** ⇒ 只刷 updatedAt 并回 200(原来会在 secret 已改之后回 400「无更新字段」)
    if (fields.length === 0 && !creds && !glueSynced) return apiError("无更新字段");

    const expr = [...fields.map((k, i) => `#f${i} = :v${i}`), "#upd = :now"].join(", ");
    const names = Object.fromEntries(fields.map((k, i) => [`#f${i}`, k]));
    const values = Object.fromEntries(fields.map((k, i) => [`:v${i}`, body[k]]));

    const { Attributes } = await docClient.send(
      new UpdateCommand({
        TableName: TABLES.DATASOURCES,
        Key: { userId: USER_ID, datasourceId: params.id },
        UpdateExpression: `SET ${expr}`,
        ExpressionAttributeNames: { ...names, "#upd": "updatedAt" },
        ExpressionAttributeValues: { ...values, ":now": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      })
    );
    recordAudit(req, "datasource.update", {
      resourceType: "datasource",
      resourceId: params.id,
      detail: { fields },
    }).catch(() => {});
    return apiOk(Attributes);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
    );
    if (!Item) return apiError("数据源不存在", 404);
    const guard = await guardResourceAccess(req, Item, "editor");
    if (guard instanceof NextResponse) return guard;
    const busy = await resourceBusyResponse([resourceKey("datasource", params.id)]);
    if (busy) return busy;
    // 序 59 B-131:仍被同步 / 实时任务引用 ⇒ 409 并逐条列出(删源不留孤儿任务,纪律 7)。原来只核权限与自身租约,
    //   源删了、Glue 连接 / 密钥 / 安全组照删,引用它的任务留在列表里,下一次定时触发才报「连接不存在」。
    const refs = await listDatasourceReferences(params.id);
    if (refs.total > 0) {
      return apiError(
        `该数据源仍被 ${refs.total} 个任务引用,先删除或改源:${describeDatasourceReferences(refs)}`,
        409,
        { code: "DATASOURCE_IN_USE", detail: { syncTasks: refs.syncTasks, flinkJobs: refs.flinkJobs } }
      );
    }
    noteDatasourceRowPlace(Item);

    let delRegion = homeRegion();
    let placeWarn = "";
    try {
      delRegion = (await resolveDsPlace(targetOfStamp((Item as any)?.ownerTargetId))).region;
    } catch (e) {
      placeWarn = `落点解析失败(${String((e as Error)?.message).slice(0, 120)})—— 已按主控区清理,` +
        `${(Item as any)?.ownerTargetId || "(无章)"} 那个区若有残留连接 / 安全组需人工确认`;
    }
    // 🔴 生产上线批次 A:只删平台自建的组(deleteSecurityGroup 内按组名再判一次归属);用户指定的组原样保留、也不入队。
    //   候选 = 批次 A 存量行单独记的 `platformSecurityGroupId`(网络即便是用户指定的,这个字段也只会是平台组)
    //        + 自动探测路径的 `securityGroupId`(用户指定网络时它是用户的组 ⇒ 不进候选)。
    const nc = (Item.networkConfig || {}) as { securityGroupId?: string; platformSecurityGroupId?: string; securityGroupIds?: unknown };
    const sgCandidates = Array.from(new Set([
      nc.platformSecurityGroupId,
      ...(isUserNetworkConfig(nc as any) ? [] : [nc.securityGroupId]),
    ].filter(Boolean) as string[]));

    // 序 58 B-130:先给每个候选组登记一条**持久**清理作业,再动任何资源 ——
    //   · 入队是一次条件写(幂等),之后由泵按网卡事实收口(网卡为 0 才删;30 分钟预算到期如实「需人工」,停在系统设置「后台清理任务」里);
    //   · 入队失败 ⇒ 拒绝删除(源还在、什么都没动,可重试),绝不出现「源删了、组没人管」(原来是进程内存里 10 × 30 秒重试,耗尽即永久遗留);
    //   · 下面同步删组成功时,作业下一步查到组已不在 ⇒ 自行收口成功,路由不必回头改它。
    const identity = (guard as { identity?: { username?: string; sub?: string } }).identity;
    const actor = `user:${identity?.username || identity?.sub || "unknown"}`;
    const cleanupJobIds: string[] = [];
    for (const sg of sgCandidates) {
      try {
        const r = await enqueueSgCleanup({ sgId: sg, region: delRegion, targetId: targetOfStamp((Item as any)?.ownerTargetId), datasourceId: params.id, createdBy: actor });
        cleanupJobIds.push(r.jobId);
      } catch (e) {
        return apiError(
          `删除数据源失败:平台安全组 ${sg} 的后台清理作业未能登记(${String((e as Error)?.message || e).slice(0, 160)}),源记录未删,请稍后重试`,
          502,
          { code: "UPSTREAM_ERROR" }
        );
      }
    }

    if (Item.glueConnectionName) {
      // 序 38 B-70:连带撤掉发现作业与它的产物(作业 / 脚本);删不净只记日志、照常往下删(连接 / 密钥 / 组是承重的清理)
      const leftover = await teardownDiscoveryArtifacts(Item as unknown as DataSource).catch((e) => [String((e as Error)?.message || e)]);
      if (leftover.length) console.warn("[datasource.delete] 发现作业 / 对象未清净,需人工确认", { datasourceId: params.id, leftover });
    }
    if (Item.glueConnectionName) await deleteGlueConnection(Item.glueConnectionName, delRegion);
    if (Item.secretArn) await deleteSecret(Item.secretArn);
    const pendingCleanup: string[] = [];
    for (const sg of sgCandidates) {
      const out = await deleteSecurityGroup(sg, delRegion, params.id);
      // 网卡占着(DependencyViolation)或别的失败 ⇒ 交给已登记的清理作业,响应里如实写明「稍后清理」
      if (out === "failed-dependency" || out === "failed") {
        pendingCleanup.push(sg);
        console.log("[datasource.delete] 平台自建安全组交后台清理作业", { sg, region: delRegion, syncOutcome: out, jobs: cleanupJobIds });
      }
    }
    if (placeWarn) console.warn("[datasource.delete]", placeWarn);

    await docClient.send(
      new DeleteCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
    );
    recordAudit(req, "datasource.delete", {
      resourceType: "datasource",
      resourceId: params.id,
      detail: {
        name: Item.name,
        type: Item.type,
        // 序 58 B-130:两态如实记 —— 组当场删掉 / 交后台清理(作业 id 可在系统设置「后台清理任务」里对上)
        securityGroupCleanup: sgCandidates.length === 0 ? "none" : pendingCleanup.length ? "scheduled" : "deleted",
        ...(cleanupJobIds.length ? { cleanupJobIds } : {}),
      },
    }).catch(() => {});
    return apiOk(pendingCleanup.length ? { deleted: true, pendingCleanup, cleanupJobIds } : { deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
