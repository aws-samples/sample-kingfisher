export const dynamic = "force-dynamic";
// 🔴 **改动前零守卫**(52 SPEC §2 缺口B;台账 §11.2 第 9 项):任一登录用户凭 taskId/workflowId
//    就能读**任意项目**的运行日志。日志里有 SQL、表名、行数、报错栈 —— 泄露面不比数据本身小。
// 🔴 两道:顶层 `requireProject(viewer)`(挡住非成员拿 id 当探测器)+ 按**资源归属项目**再判一次。
// MWAA 环境 / 桶只经解析器(home 逐字节不变)
// 日志组名必须来自**该工作流落点**的环境(不是主控区)
import { schedulerEndpointFor, isServerlessEndpoint } from "@/lib/scheduler/mwaa-endpoint";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { logGroupOf } from "@/lib/scheduler/serverless/task-logs";
import { serverlessWorkflowArnOf } from "@/lib/workflow/publish-dag";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { requireProject, guardResourceAccess } from "@/lib/projects/guard";
// 🔴 日志必须去**这条 run 实际执行的那个区**取。
// 原来这里是一个模块级 home S3 客户端 + home CloudWatch 客户端:非主控区跑的运行点开日志,
// 取到的是**主控区那个桶里不存在的对象**,catch 掉之后界面显示「暂无日志」——
// 而「暂无日志」与「作业没有输出」长得一模一样,排障时会往完全错误的方向走。
// 修法与 api/etl-jobs/[id]/logs 同一条纪律:按 run 行上的章解析落点,**解析不到就如实报错,不回落 home**。
import { resolveGlueBinding, stampedTargetOf } from "@/lib/exec-env/data-plane-target";
import { s3ClientFor, logsClientFor } from "@/lib/exec-env/target-clients";
// 平台动作的调度对象(治理定时任务 / 卡片定时刷新)
import { getActionSchedule, actionCarrierDagId } from "@/lib/scheduler/action-schedules";
// 手动造数的 run(Glue 日志在该区)
import { isSeedRunTaskId } from "@/lib/seed/seed-job";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const gctx = await requireProject(req, "viewer");
  if (gctx instanceof NextResponse) return gctx;
  const runId = req.nextUrl.searchParams.get("runId");

  // Try sync task first
  const { Item: task } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } }));

  if (task) {
    // 🔴 权威那一道:按同步任务自己的归属项目判(不是调用方的 active project)。
    const tctx = await guardResourceAccess(req, task as { projectId?: string }, "viewer");
    if (tctx instanceof NextResponse) return tctx;
    // 🔴 尊重 `runId`:原来**恒取最新一条** run ⇒ 在运行历史里点第 3 条的日志,看到的是最新那条的
    //    (或者最新那条没有 logS3Key ⇒ 直接「暂无日志」)。点哪条就取哪条,取不到就说清楚。
    let run: Record<string, unknown> | undefined;
    if (runId) {
      const got = await docClient.send(new GetCommand({
        TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId },
      }));
      run = got.Item as Record<string, unknown> | undefined;
    }
    if (!run) {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: TABLES.TASK_RUNS, KeyConditionExpression: "taskId = :t",
        ExpressionAttributeValues: { ":t": params.id }, ScanIndexForward: false, Limit: 1,
      }));
      run = Items[0] as Record<string, unknown> | undefined;
    }
    if (run?.logS3Key) {
      // 🔴 桶名也随区变(每个区一套脚本/日志桶)⇒ 桶与客户端都从同一个落点解析器来,
      // 不再读 `process.env.GLUE_SCRIPTS_BUCKET`(那是主控区那一套的快照)。
      const tid = (run as { targetId?: string } | undefined)?.targetId;
      let bucket = "";
      let s3c: { send: (c: unknown) => Promise<any> } | null = null;
      try {
        const b = await resolveGlueBinding({ targetId: stampedTargetOf(run) });
        bucket = b.scriptsBucket;
        s3c = (await s3ClientFor(b.region)) as any;
      } catch (e) {
        return NextResponse.json(
          {
            logs: [],
            error:
              `取不到这条运行的执行区域(targetId=${tid || "(空)"}):${(e as Error)?.message}。` +
              `🔴 刻意不回落主控区去取 —— 那会拿到一份别的区域的空日志,而界面上「暂无日志」` +
              `与「作业没有输出」看起来完全一样`,
          },
          { status: 409 }
        );
      }
      try {
        const { Body } = await s3c!.send(new GetObjectCommand({ Bucket: bucket, Key: String(run.logS3Key) }));
        const text = await Body!.transformToString();
        return NextResponse.json({ logs: text.split("\n").map((line: string) => ({ message: line })) });
      } catch (e) {
        // 🔴 取不到就说清「去哪个区的哪个桶找的什么键」,别用「暂无日志」把定位线索吞掉
        return NextResponse.json({
          logs: [{ message: `暂无日志(已在 ${bucket} 找 ${run.logS3Key}:${(e as Error)?.message})` }],
        });
      }
    }
    return NextResponse.json({ logs: [{ message: "暂无日志" }] });
  }

  // Try workflow
  const { Item: wf } = await docClient.send(new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: params.id } }));
  if (wf) {
    // 🔴 同上:按工作流自己的归属项目判。
    const wctx = await guardResourceAccess(req, wf as { projectId?: string }, "viewer");
    if (wctx instanceof NextResponse) return wctx;
    const dagId = wf.airflowDagId;
    if (!dagId) return NextResponse.json({ logs: [{ message: "工作流尚未发布" }] });

    try {
      const { FilterLogEventsCommand, DescribeLogStreamsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
      // 🔴 工作流日志同理按区取。目标态是**每区一套 MWAA Serverless、调度只在本区执行**
      // (用户 2026-09-10 第三次强调),那时日志组就在本区;现网只有主控区一个环境,
      // 所以 `resolveGlueBinding` 对 home 解出来的就是主控区 —— 逐字节等价于改动前的行为。
      // 逐区环境建好后**这里不用再改**(只需让 run 行盖上真章)。
      // 🔴 这三行原来有**两个**洞
      //   ① 落点取 `(wf as {targetId}).targetId`,而路由写工作流用的是 `targets[]`(B 类绑定字段名)
      //      ⇒ 绑在别区的工作流这里解出 undefined ⇒ 回落主控区 region;
      //   ② 日志组名写的是 `homeMwaaEndpoint().envName` ⇒ **恒是主控区那个环境名**,
      //      于是「region 对了、组名不对」⇒ DescribeLogStreams 空 ⇒ 页面显示「暂无日志」,
      //      与「任务真的没输出」长得一模一样(最难查的一类)。
      //   现在按落点解析调度端点:经典 = 该区环境的 `airflow-<env>-Task`;serverless = 服务自己的日志组
      //   (逐节点日志在工作流详情里看,这里给人话 + 组名而不是空白)。
      const wfTarget = bindingTargets(wf as { targets?: unknown; targetId?: unknown })[0] || HOME_TARGET_ID;
      const wfEp = await schedulerEndpointFor(wfTarget);
      const cwl = (await logsClientFor(wfEp.region)) as any;
      if (isServerlessEndpoint(wfEp)) {
        const arn = await serverlessWorkflowArnOf(
          { workflowId: params.id, airflowDagId: String(dagId), deployments: (wf as { deployments?: unknown }).deployments },
          wfEp
        );
        return NextResponse.json({
          logs: [{ message: arn
            ? `该工作流跑在 MWAA Serverless(${wfEp.region});逐节点日志请在工作流详情的「运行历史 → 节点」里看。CloudWatch 日志组:${logGroupOf(arn)}`
            : `该工作流跑在 MWAA Serverless(${wfEp.region}),但在服务侧找不到同名 workflow(${dagId})—— 请重新发布一次` }],
        });
      }
      const logGroup = `airflow-${wfEp.envName}-Task`;

      // Build stream prefix: Airflow replaces : with _ in log stream names
      const sanitizedRunId = runId?.replace(/:/g, "_");
      const prefix = sanitizedRunId ? `dag_id=${dagId}/run_id=${sanitizedRunId}/` : `dag_id=${dagId}/`;
      // 客户端是按区解析出来的(类型上是窄接口)⇒ 这里给流对象一个显式形状,别退回隐式 any
      const { logStreams = [] } = (await cwl.send(new DescribeLogStreamsCommand({
        logGroupName: logGroup, logStreamNamePrefix: prefix, limit: 20,
      }))) as { logStreams?: Array<{ logStreamName?: string }> };

      if (!runId && logStreams.length > 0) {
        // No specific run: get latest run's streams
        const runIds = Array.from(new Set(logStreams.map((s: { logStreamName?: string }) => s.logStreamName?.split("/")[1] || "")));
        const latestRunId = runIds[runIds.length - 1];
        const filtered = logStreams.filter((s: { logStreamName?: string }) => s.logStreamName?.includes(latestRunId));
        return await fetchLogsFromStreams(cwl, logGroup, filtered);
      }

      return await fetchLogsFromStreams(cwl, logGroup, logStreams);
    } catch {}

    return NextResponse.json({ logs: [{ message: "暂无日志" }] });
  }

  // 🔴 平台动作的调度对象:日志在**该区**的 MWAA Serverless 日志组里(节点 print 了命令号 / 结果摘要);
  //    run 行上的 error 就是消费端写回的真因 —— 一并给出,不让用户只看到「暂无日志」。
  const sched = await getActionSchedule(params.id);
  if (sched) {
    const sctx = await guardResourceAccess(req, sched, "viewer");
    if (sctx instanceof NextResponse) return sctx;
    const msgs: Array<{ message: string }> = [];
    if (runId) {
      const got = await docClient.send(new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId } }));
      const run = got.Item as Record<string, unknown> | undefined;
      if (run?.error) msgs.push({ message: `失败原因(消费端写回):${String(run.error)}` });
      if (run?.status) msgs.push({ message: `状态:${String(run.status)}(${String(run.triggeredBy || "")})` });
    }
    const tgt = (sched.targets || [])[0] || "";
    try {
      const ep = await schedulerEndpointFor(tgt);
      if (isServerlessEndpoint(ep)) {
        const arn = await serverlessWorkflowArnOf(
          { workflowId: sched.taskId, airflowDagId: actionCarrierDagId(sched.taskId), deployments: sched.deployments },
          ep
        );
        msgs.push({ message: arn
          ? `该定时任务跑在 ${ep.region} 的 MWAA Serverless(工作流 ${actionCarrierDagId(sched.taskId)});CloudWatch 日志组:${logGroupOf(arn)}(节点日志里有命令号与结果摘要)`
          : `该定时任务在 ${ep.region} 的 MWAA Serverless 上找不到载体(${actionCarrierDagId(sched.taskId)})—— 没启用过,或已停用` });
      }
    } catch (e) {
      msgs.push({ message: `取不到该定时任务所在区(${tgt || "空"})的调度端点:${(e as Error)?.message ?? String(e)}` });
    }
    return NextResponse.json({ logs: msgs.length ? msgs : [{ message: "暂无日志" }] });
  }

  // 手动造数(台账对象 `seed_<targetId>`,每区一个,不在任何任务表里)
  //   🔴 守卫按 **run 行自己的归属项目**判(这个对象没有资源行;run 行就是唯一的归属事实)。
  if (isSeedRunTaskId(params.id)) {
    let run: Record<string, unknown> | undefined;
    if (runId) {
      run = (await docClient.send(new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId } }))).Item as Record<string, unknown> | undefined;
    } else {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: TABLES.TASK_RUNS, KeyConditionExpression: "taskId = :t",
        ExpressionAttributeValues: { ":t": params.id }, ScanIndexForward: false, Limit: 1,
      }));
      run = Items[0] as Record<string, unknown> | undefined;
    }
    const rctx = await guardResourceAccess(req, (run as { projectId?: string } | undefined) ?? undefined, "viewer");
    if (rctx instanceof NextResponse) return rctx;
    if (!run) return NextResponse.json({ logs: [{ message: `找不到这次造数的运行记录(${params.id} · ${runId || "最新"})` }] });
    const { readSeedRunLogs } = await import("@/lib/seed/seed-logs");
    return NextResponse.json({ logs: await readSeedRunLogs(run) });
  }

  // 🔴🔴 用户 2026-09-15 报的真缺陷:「跑完的任务都没有日志,点日志显示暂无日志」。
  //    根因是这个端点**只认识同步任务与工作流**:监控页的运行历史早就把 ETL / 引擎(Glue·EMR·Redshift)
  //    的 run 一起列出来了,而它们的 taskId 在上面两张表里都查不到 ⇒ 直接落到这句
  //    `{logs: [], message: "暂无日志"}`。而同一条 run 的日志**明明取得到**(实测
  //    `/api/etl-jobs/<id>/logs?runId=` 回的是 Glue error/output 两个日志流的真实内容)。
  //    ⇒ 又一例「写了没接上」:列表接上了多引擎,日志按钮没接。
  // 修法:**委派给各自那个已经写好的读取器**,不在这里抄第二份(日志读取涉及三种引擎 × 按区客户端 ×
  //    serverless/经典分路,抄一份必然漂移)。返回体统一成 `{logs: [{message}]}` 给页面。
  const asMessages = (logs: unknown): Array<{ message: string; timestamp?: number }> =>
    Array.isArray(logs)
      ? logs.map((l) => (typeof l === "string" ? { message: l } : (l as { message: string; timestamp?: number })))
      : [];
  const delegated = async (r: NextResponse): Promise<NextResponse> => {
    const body = (await r.clone().json().catch(() => ({}))) as { data?: { logs?: unknown }; logs?: unknown; error?: { message?: string } };
    const logs = asMessages(body?.data?.logs ?? body?.logs);
    if (logs.length > 0) return NextResponse.json({ logs });
    const why = body?.error?.message;
    return NextResponse.json({ logs: why ? [{ message: `取不到日志:${why}` }] : [] , message: why ? undefined : "暂无日志" });
  };

  const { Item: etlJob } = await docClient.send(new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (etlJob) {
    const { GET: etlLogs } = await import("@/app/api/etl-jobs/[id]/logs/route");
    return delegated(await etlLogs(req, { params: Promise.resolve({ id: params.id }) }));
  }

  const { Item: engineJob } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (engineJob) {
    const engine = String((engineJob as { engine?: string }).engine || "emr-serverless");
    const { GET: engineLogs } = await import("@/app/api/engines/[engine]/[id]/logs/route");
    return delegated(await engineLogs(req, { params: Promise.resolve({ engine, id: params.id }) }));
  }

  // 🔴 连作业本身都找不到:如实说(它与「作业没有输出」是两件事 —— 多半是作业已被删除,
  //    run 台账按设计保留)。绝不再用一句光秃秃的「暂无日志」把线索吞掉。
  return NextResponse.json({
    logs: [{ message: `找不到这条运行所属的任务(taskId=${params.id})—— 同步任务 / 工作流 / 离线作业 / 引擎作业四张表里都没有。多半是作业已被删除,而运行台账按设计保留;日志随作业一起清掉了。` }],
  });
}

async function fetchLogsFromStreams(cwl: any, logGroup: string, streams: any[]) {
  const { FilterLogEventsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
  const allLogs: any[] = [];
  for (const stream of streams.slice(0, 10)) {
    try {
      const { events = [] } = await cwl.send(new FilterLogEventsCommand({
        logGroupName: logGroup, logStreamNames: [stream.logStreamName!], limit: 200,
      }));
      for (const e of events) {
        allLogs.push({ timestamp: e.timestamp, message: e.message?.trim() });
      }
    } catch {}
  }
  allLogs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return NextResponse.json({ logs: allLogs.length > 0 ? allLogs : [{ message: "暂无日志" }] });
}
