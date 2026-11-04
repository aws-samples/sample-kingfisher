export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { PutCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, projectFilter, getActiveEnv, envFilter } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { defaultFlinkSql, mysqlSinkSql, s3TableSinkSql, customSinkSql, reconcileFlinkJobs, normalizeFlinkSql, resolveKinesisStreamName } from "@/lib/realtime/flink-service";
import { guardCode } from "@/lib/cookbook";
// 🔴 实时作业的执行区。用户 2026-09-10:
// 「一定要加这个维度,不然白干了,所有任务都在自己的区域跑,不然没有意义。」
// 读侧按 `targets[]` 过滤(B 类绑定,三级回落归主控区);写侧在**新建那一刻**盖章,
// 并且**在盖章前先真解析一遍落点**(`resolveFlinkPlace` 会核 flink 组件 + 角色 + 三个桶,主控区也一样)——
// 「绑得上、跑不了」是最难查的形态:界面绿、启动时才 AccessDenied。
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { assertBindableTargets } from "@/lib/exec-env/data-plane-target";
import { resolveFlinkPlace } from "@/lib/realtime/flink-place";
// 执行角色 ARN 形态 / 保存期预检的唯一作者
import { roleArnShapeRejection } from "@/lib/execution-role/resolve";
import { preflightCustomRoleForTargets } from "@/lib/execution-role/preflight";
import { isValidTargetId, HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { ulid } from "ulid";

const USER_ID = "default-user";

// GET /api/flink/jobs — 列出当前项目+环境下的 Flink 流作业。
// 读时对账(reconcile-on-read):对非终态作业查 MSAF 真实状态并回写,杜绝列表显示假 running/starting;
// AWS 侧应用已不存在(被外部删/账号回收)→ 状态降级为 deleted(与用户主动 stopped 区分)。
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireProject(req, "viewer");
    if (ctx instanceof NextResponse) return ctx;
    const pf = projectFilter(ctx.projectId);
    const ef = envFilter(getActiveEnv(req));
    const { Items = [] } = await docClient.send(new ScanCommand({
      TableName: TABLES.FLINK_JOBS,
      FilterExpression: ["userId = :uid", pf.clause, ef.clause].join(" AND "),
      ExpressionAttributeNames: { "#env": "env" },
      ExpressionAttributeValues: { ":uid": USER_ID, ...pf.values, ...ef.values },
    }));
    // 🔴 `readScope` 回 null(未传 `?scope=` / 全局)⇒ 恒等过滤 ⇒ 与改动前逐字节相同(回滚点)。
    //    过滤放在**对账之前**:对账要对每个非终态作业打一次 MSAF,过滤掉的行不必打(省调用、省钱)。
    const scope = readScope(req);
    const rows = scope
      ? (filterRowsByScope(Items as Array<Record<string, unknown>>, scope) as typeof Items)
      : Items;
    rows.sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    // 并发对账(仅非终态作业会真正查后端;终态直接返回,省调用)。失败不阻塞列表。
    // 全局列表 = 一次请求碰多个区 ⇒ 按区扇出走唯一写法(reconcileFlinkJobs → forEachTargetPlace)
    await reconcileFlinkJobs(rows as Array<Record<string, any>>);
    // 🔴 **「源流」这一列必须是它真正消费的那条流**,不能是建作业时存下来的快照。
    //   落库的 `sourceStream` 取的是 `process.env.FLINK_SOURCE_STREAM || "bgp-flink-source"` ——
    //   而平台**刻意不建固定流**(2026-07-26 拍板:流由数据源 provision 按需新建)⇒ 那个默认名
    //   **根本不存在**。真环境实测:示范作业消费的是 `bgp-showcase-home-rt`,而页面的「源流」列
    //   写着 `bgp-flink-source` —— 界面在说一条不存在的流的名字(同一类「部署期快照 vs 运行期解析」)。
    //   ⇒ 读侧按**唯一作者** `resolveKinesisStreamName` 派生(与启动侧、造数侧同一个函数),
    //     前端优先显示派生值;存量字段只作回落。派生失败不阻塞列表。
    await Promise.all(rows.map(async (it: any) => {
      if (it.sourceType && it.sourceType !== "kinesis") return;
      try { it.sourceStreamResolved = await resolveKinesisStreamName(it.sourceDatasourceId); } catch { /* 回落存量值 */ }
    }));
    return apiOk(rows);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/flink/jobs — 创建 Flink SQL 流作业(草稿)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json();
  if (!body.name) return apiError("请输入作业名称", 400);
  const sinkType = body.sinkType || "s3"; // s3 | mysql | s3table | custom
  const rawSql = (body.sql && String(body.sql).trim())
    || (sinkType === "mysql" ? mysqlSinkSql() : sinkType === "s3table" ? s3TableSinkSql() : sinkType === "custom" ? customSinkSql() : defaultFlinkSql());
  // 🔴 落库前规范化(与 PUT 编辑、启动注入同源):压平累进缩进 + guard 机械纠正(去末尾编辑器残留孤立括号)。
  //    保证 DDB/页面/MSAF 三处 SQL 一致,且不会存进注定 Calcite 解析失败的碎片。只清格式,不改语义。
  const sql = guardCode("flink", normalizeFlinkSql(rawSql));
  if (!/insert\s+into/i.test(sql)) {
    return apiError("Flink SQL 必须包含 INSERT INTO(否则无 sink,流作业不会产出)", 400);
  }
  if (sinkType === "mysql" && !body.sinkDatasourceId) {
    return apiError("MySQL sink 需选择目标数据源(连接串/账号由其安全注入,不入库)", 400);
  }
  if (sinkType === "custom" && (!Array.isArray(body.connectorIds) || body.connectorIds.length === 0)) {
    return apiError("自定义 sink 需选择至少一个已上传的连接器 JAR(在「连接器管理」上传)", 400);
  }
  // 多 source:数据源类型(kinesis 默认 / mysql-cdc 直读 binlog / msk Kafka 流)。
  const sourceType = ["mysql-cdc", "msk", "kinesis"].includes(body.sourceType) ? body.sourceType : "kinesis";
  const isCdc = sourceType === "mysql-cdc";
  const isMsk = sourceType === "msk"; // MSK/Kafka 源(broker 在私有 VPC,同 CDC 要选源数据源+网络)
  const isVpcSource = isCdc || isMsk; // 源在私有 VPC 的流源(CDC 读 RDS binlog / MSK 连 broker)
  if (isCdc && !body.sourceDatasourceId) {
    return apiError("MySQL CDC 源需选择源数据源(binlog 账密由其安全注入,不入库)", 400);
  }
  if (isMsk && !body.sourceDatasourceId) {
    return apiError("MSK 源需选择源数据源(连接/认证/topic 由其提供,密钥不入库)", 400);
  }
  const csv = (v: any) => Array.isArray(v) ? v.filter((s: any) => typeof s === "string" && s.trim()) : [];
  if (isVpcSource && (csv(body.vpcSubnets).length === 0 || csv(body.vpcSecurityGroups).length === 0)) {
    return apiError(isMsk ? "MSK 源需选择 VPC 子网 + 安全组(连私有 broker 9098/9096)" : "MySQL CDC 需选择 VPC 子网 + 安全组(连私有 RDS 读 binlog)", 400);
  }
  // VPC 接入:自定义 sink / MySQL CDC 源 / MSK 源都需用户选私有子网 + SG(平台只透传,可达性用户自理)。
  const needVpc = sinkType === "custom" || isVpcSource;
  const vpcSubnets = needVpc ? csv(body.vpcSubnets) : [];
  const vpcSecurityGroups = needVpc ? csv(body.vpcSecurityGroups) : [];
  // 资源配置(用户可配,配置驱动):并行度 / 每 KPU 并行度 / 自动扩缩。规整在后端 normalizeResources 兜底。
  const num = (v: any, dft: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : dft; };
  const parallelism = num(body.parallelism, 1);
  const parallelismPerKPU = num(body.parallelismPerKPU, 1);
  const autoScalingEnabled = body.autoScalingEnabled === true;
  // 参数齐全暴露(对齐 MSAF console):checkpoint / 日志级别 / 指标级别 / 快照 / 自定义运行时属性。
  const checkpointingEnabled = body.checkpointingEnabled !== false;
  const checkpointIntervalMs = num(body.checkpointIntervalMs, 30000);
  const minPauseBetweenCheckpointsMs = num(body.minPauseBetweenCheckpointsMs, 5000);
  const logLevel = ["DEBUG", "INFO", "WARN", "ERROR"].includes(body.logLevel) ? body.logLevel : "INFO";
  const metricsLevel = ["APPLICATION", "TASK", "OPERATOR", "PARALLELISM"].includes(body.metricsLevel) ? body.metricsLevel : "APPLICATION";
  const snapshotsEnabled = body.snapshotsEnabled === true;
  // 自定义执行角色 ARN(可选):留空=启动时回退该落点的平台 Flink 运行角色。形态校验走单一作者;
  // 账号内任何 kinesisanalytics 可承担的角色都能绑(平台任务角色 PassRole role/* + PassedToService),
  //   在落点校验之后按每个区**预检**(信任策略 + 引擎基线),缺 ⇒ 400 指路、不落库。
  const execRoleRaw = (body.executionRoleArn || "").trim();
  {
    const shapeReject = execRoleRaw ? roleArnShapeRejection(execRoleRaw) : null;
    if (shapeReject) return apiError(shapeReject, 400, { code: "VALIDATION_FAILED" });
  }
  const executionRoleArn = execRoleRaw || null;
  const runtimeProperties = Array.isArray(body.runtimeProperties)
    ? body.runtimeProperties.filter((g: any) => g && typeof g.groupId === "string" && g.groupId.trim() && g.groupId !== "bgp" && g.properties && typeof g.properties === "object")
    : [];
  // 执行落点。
  // 🔴 不从 `...body` 裸抄:那等于让前端往权威字段里写任意字符串。只认合法 targetId,
  //    并且**当场真解析一遍**(缺 flink 组件 / 角色不是本 target 的 / 桶缺项 ⇒ 400 可修),
  //    而不是先存下来、等启动时才炸。
  // 🔴🔴 用户 2026-09-15:「实时计算…我不是让你在美东1 发布执行多个区域吗?」
  //    流式作业**天生一区一个应用**(MSAF application 是区域资源),所以「一次发布多区」的正确语义是
  //    **一次提交 → 每个区各建一个作业**(而不是一个作业跑两区)。这里接 `targets` 多值:
  //    逐个校验(可绑 + flink 组件 + 角色/桶真解析得开),**任一个不合格就整体拒**(不许先建一半)。
  // 🔴 绑定区必须点名(缺 / 非法 ⇒ 400),不再「没给 = 主控区」
  let wantTargets: string[];
  try {
    wantTargets = requestedTargets(body, "新建实时作业");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  // 收尾:🔴 **主控区也过同一道校验**(原来 `if (t === HOME_TARGET_ID) continue;`
  //   ⇒ 主控区从来不核「装没装 flink / 角色与三个桶在不在描述符里」,建得出、启动才炸)。
  //   真解析改走启动侧同一个作者 `resolveFlinkPlace`(主控区也读描述符),建与跑不再是两套口径。
  for (const t of wantTargets) {
    try {
      // scope 必填后 tsc 逼出来的一处:原来不传 ⇒ projectId 缺省 undefined
      //   ⇒ 设了「授权项目」白名单的区**永远**建不了实时作业(本项目在白名单里也不行)。现在带本请求的项目。
      await assertBindableTargets([t], "flink", { scope: "per-project", projectId: ctx.projectId });
      await resolveFlinkPlace(t);
    } catch (e: any) {
      return apiError(
        `不能把实时作业建在 ${t}:${String(e?.message || e)}`,
        400,
        { code: "VALIDATION_FAILED" }
      );
    }
  }
  // 自定义执行角色在建作业那一刻就按每个落点预检,缺 ⇒ 400(文案逐条列动作 → 资源 → 为什么要 + 出路)
  {
    const pfRes = await preflightCustomRoleForTargets({ engine: "flink", customRoleArn: execRoleRaw, targets: wantTargets });
    if (pfRes) return pfRes;
  }
  // 🔴🔴 **实时作业不许跨区取数/写数**:源 / 目标数据源都有落点章(`ownerTargetId`),
  //    如果它属于另一个区,那这个作业就是「在 A 区跑、去 B 区读写」——跨法域下就是数据出境,
  //    而且症状会表现成运行期连不上(指不到根因)。⇒ 建之前逐个核,**不匹配就拒并说清是哪个源属于哪个区**。
  const dsIds = [body.sourceDatasourceId, body.sinkDatasourceId].filter((x: unknown): x is string => typeof x === "string" && !!x.trim());
  if (dsIds.length && wantTargets.length) {
    for (const dsId of dsIds) {
      const { Item: ds } = await docClient.send(
        new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: dsId } })
      );
      const owner = String((ds as { ownerTargetId?: string } | undefined)?.ownerTargetId || HOME_TARGET_ID);
      const wrong = wantTargets.filter((t) => t !== owner);
      if (wrong.length) {
        return apiError(
          `实时作业不许跨区取数:数据源 ${dsId} 属于 ${owner},而这次要建在 ${wrong.join("/")}。` +
            `⇒ 请在这些区各自建一个本区的数据源(建源时顶栏切到那个区),再分别建作业。`,
          400,
          { code: "VALIDATION_FAILED" }
        );
      }
    }
  }
  const wantTarget = wantTargets[0];
  const now = new Date().toISOString();
  const item = {
    userId: USER_ID,
    jobId: ulid(),
    // 🔴 字段名用平台 B 类绑定的默认名 `targets` ⇒ 读侧过滤与三级回落直接复用,不另写判定
    //   (模板里先放第一个区;下面按 `wantTargets` 逐区各建一个,每个作业**只带自己那一个区**)
    targets: [wantTargets[0]],
    projectId: ctx.projectId,
    env: getActiveEnv(req),
    name: body.name,
    sql,
    sinkType,
    sinkDatasourceId: body.sinkDatasourceId || null,
    sourceType,
    // CDC=MySQL 源 / MSK=MSK 源(均必选);kinesis=Kinesis 数据源(可选,留空后端回退默认流)。其余类型无源数据源。
    sourceDatasourceId: (isVpcSource || sourceType === "kinesis") ? (body.sourceDatasourceId || null) : null,
    connectorIds: Array.isArray(body.connectorIds) ? body.connectorIds : [],
    vpcSubnets,
    vpcSecurityGroups,
    parallelism,
    parallelismPerKPU,
    autoScalingEnabled,
    checkpointingEnabled,
    checkpointIntervalMs,
    minPauseBetweenCheckpointsMs,
    logLevel,
    metricsLevel,
    snapshotsEnabled,
    runtimeProperties,
    executionRoleArn,
    sourceStream: process.env.FLINK_SOURCE_STREAM || "bgp-flink-source",
    status: "draft",
    createdBy: ctx.identity.username,
    createdBySub: ctx.identity.sub,
    createdAt: now,
    updatedAt: now,
  };
  try {
    // 一个区一个作业:名字后缀带区(否则两个同名作业在列表里分不出来)
    const created: Array<Record<string, unknown>> = [];
    for (const t of wantTargets) {
      const one = {
        ...item,
        jobId: created.length === 0 ? item.jobId : ulid(),
        targets: [t],
        name: wantTargets.length > 1 ? `${item.name}-${t.replace(/^tgt_/, "")}` : item.name,
      };
      await docClient.send(new PutCommand({ TableName: TABLES.FLINK_JOBS, Item: one }));
      created.push(one);
    }
    recordAudit(req, "flink.create", {
      resourceType: "flink", resourceId: String(created[0].jobId),
      detail: { name: item.name, targets: wantTargets, jobIds: created.map((x) => x.jobId) },
    }).catch(() => {});
    // 单区:响应逐字节同改动前(回那一个作业);多区:回全部 + 逐区清单
    return wantTargets.length === 1
      ? apiOk(created[0], 201)
      : apiOk({ ...created[0], multiRegion: true, created: created.map((x) => ({ targetId: (x.targets as string[])[0], jobId: x.jobId, name: x.name })) }, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
