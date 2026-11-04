// MWAA Serverless workflow 生命周期的**唯一**客户端(SPEC v3.27 §3.15)。create / update / delete / stop runs / get run / task instances。
// 🔴 spike 坐实:定义 / 代码桶必须与 workflow 同 region;新桶数小时内 S3 返回 307 Temporary Redirect ⇒ CreateWorkflow 报 ValidationException
//    「Failed to download YAML file from S3: Temporary Redirect」—— 这是**可重试**的(桶 DNS 传播),其余 ValidationException 不重试。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  MWAAServerlessClient,
  CreateWorkflowCommand,
  UpdateWorkflowCommand,
  DeleteWorkflowCommand,
  GetWorkflowCommand,
  StartWorkflowRunCommand,
  StopWorkflowRunCommand,
  GetWorkflowRunCommand,
  ListWorkflowRunsCommand,
  ListWorkflowsCommand,
  ListTaskInstancesCommand,
  GetTaskInstanceCommand,
} from "@aws-sdk/client-mwaa-serverless";

const clients = new Map<string, MWAAServerlessClient>();
export function serverlessClientFor(region: string): MWAAServerlessClient {
  let c = clients.get(region);
  if (!c) {
    c = sdkClient("data-plane", MWAAServerlessClient, { region });
    clients.set(region, c);
  }
  return c;
}

/** 新桶 307 / 传播期:可重试;其余一律不重试(纯函数,单测钉)。 */
export function isTransientS3Redirect(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return /Temporary Redirect|Status Code: 307/i.test(msg);
}

/**
 * 🔴 **刚 CreateWorkflow 完就 StartWorkflowRun** 会撞到一段传播窗口:
 *   `ValidationException: Workflow execution role could not be assumed by the airflow-serverless service`
 * 2026-09-19 全新账号首装真撞:角色的信任策略**完全正确**(`airflow-serverless.amazonaws.com` +
 * `sts:AssumeRole`,栈里写死的),`CreateWorkflow` 也成功返回 READY,但紧接着的 StartWorkflowRun 被拒;
 * 同一个 workflow 过几十秒后用 CLI 直接 StartWorkflowRun **一次就成功** —— 也就是说这是**瞬态**,
 * 不是配置错。而产品把它当硬失败抛成 500 ⇒ 用户在页面上看到的是「编排触发失败」,
 * 而正确的产品行为是像 307 那样等一会儿重试(交互式触发等几十秒是可接受的)。
 *
 * 🔴 判别力:只认这一句(角色 + 不能被 assume + 那个服务),不写成宽泛的 /AccessDenied/ ——
 *   真正的信任策略配错也会报同一族错误,那种**必须**立刻红给人看,不能被重试掩盖成「慢」。
 *   区分靠的是「几十秒后自己会好」这个事实:重试窗口封顶,过了还不行就照原样抛出去。
 */
export function isTransientRoleNotAssumable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return /role could not be assumed by the airflow-serverless service/i.test(msg);
}

export interface EnsureWorkflowInput {
  region: string;
  name: string;
  /** 已有 workflow(台账里的 arn)⇒ UpdateWorkflow;否则 CreateWorkflow */
  existingArn?: string;
  definition: { bucket: string; key: string };
  code: { bucket: string; key: string };
  roleArn: string;
  network: { subnetIds: string[]; securityGroupIds: string[] };
  triggerMode?: "scheduled" | "manual_only" | "disabled";
  description?: string;
}
export interface EnsureWorkflowResult {
  workflowArn: string;
  workflowVersion: string;
  workflowName: string;
  created: boolean;
}

/** 重试策略:307 传播期最多 6 次 × 10s(交互式发布不能等 5 分钟;超过就把人话抛出去)。 */
export async function ensureWorkflow(input: EnsureWorkflowInput, opts: { attempts?: number; intervalMs?: number } = {}): Promise<EnsureWorkflowResult> {
  const attempts = opts.attempts ?? 6;
  const intervalMs = opts.intervalMs ?? 10_000;
  if (!input.network.subnetIds.length || !input.network.securityGroupIds.length) {
    // 🔴 spike 坐实:默认网络连不到跨区端点(台账回写 home 挂到 connect timeout)⇒ 无 VPC 配置一律拒
    throw new Error("serverless workflow 必须带 NetworkConfiguration(该区私有子网 + 工作 SG):默认网络连不到 home 的 DynamoDB,台账回写会挂死");
  }
  const c = serverlessClientFor(input.region);
  const common = {
    DefinitionS3Location: { Bucket: input.definition.bucket, ObjectKey: input.definition.key },
    Code: { S3Location: { Bucket: input.code.bucket, ObjectKey: input.code.key } },
    RoleArn: input.roleArn,
    NetworkConfiguration: { SubnetIds: input.network.subnetIds, SecurityGroupIds: input.network.securityGroupIds },
    TriggerMode: input.triggerMode ?? "scheduled",
  };
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      if (input.existingArn) {
        const r = await c.send(new UpdateWorkflowCommand({ WorkflowArn: input.existingArn, ...common }));
        return { workflowArn: r.WorkflowArn ?? input.existingArn, workflowVersion: r.WorkflowVersion ?? "", workflowName: workflowNameOf(r.WorkflowArn ?? input.existingArn), created: false };
      }
      const r = await c.send(new CreateWorkflowCommand({ Name: input.name, ...(input.description ? { Description: input.description } : {}), ...common }));
      if (!r.WorkflowArn) throw new Error("CreateWorkflow 未返回 WorkflowArn");
      return { workflowArn: r.WorkflowArn, workflowVersion: r.WorkflowVersion ?? "", workflowName: workflowNameOf(r.WorkflowArn), created: true };
    } catch (e) {
      lastErr = e;
      if (input.existingArn && /ResourceNotFound/i.test(String((e as Error)?.name ?? "") + String((e as Error)?.message ?? ""))) {
        // 台账里的 arn 已不存在(被人删了)⇒ 重新 Create
        input = { ...input, existingArn: undefined };
        continue;
      }
      if (!isTransientS3Redirect(e) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  const msg = String((lastErr as Error)?.message ?? lastErr);
  throw new Error(isTransientS3Redirect(lastErr) ? `定义桶刚建好、S3 DNS 仍在传播(307),${attempts} 次重试未过 —— 几分钟后再点一次发布即可。原文:${msg}` : msg);
}

/**
 * 按**名字**找 workflow 的 ARN(名字 = dagId;服务侧 ARN 带随机后缀,所以名字是唯一可推导的键)。
 * 🔴 为什么要这个:重新发布必须走 UpdateWorkflow(同名 CreateWorkflow 会被服务拒),而 ARN 只在台账里。
 *   台账丢了 / 行被重建 / 别人手工建过同名的,都会让「台账里没有 ⇒ 那就 Create」变成失败或**孤儿**
 *   (已经付过一次孤儿的学费)。所以:台账优先,台账没有就问服务本身 —— 服务是真值源。
 */
export async function findWorkflowArnByName(region: string, name: string): Promise<string | undefined> {
  const c = serverlessClientFor(region);
  let token: string | undefined;
  do {
    const r = await c.send(new ListWorkflowsCommand({ MaxResults: 50, ...(token ? { NextToken: token } : {}) }));
    for (const w of r.Workflows ?? []) {
      if (w.Name === name && w.WorkflowArn) return w.WorkflowArn;
    }
    token = r.NextToken;
  } while (token);
  return undefined;
}

export function workflowNameOf(arn: string): string {
  const i = arn.lastIndexOf("workflow/");
  return i >= 0 ? arn.slice(i + "workflow/".length) : arn;
}

/** 下线:先 Stop 在跑 / 排队的 run,再 DeleteWorkflow(不存在视为已删)。 */
export async function deleteWorkflow(region: string, workflowArn: string): Promise<{ deleted: boolean; stoppedRuns: number }> {
  const c = serverlessClientFor(region);
  let stoppedRuns = 0;
  try {
    const runs = await c.send(new ListWorkflowRunsCommand({ WorkflowArn: workflowArn }));
    for (const r of runs.WorkflowRuns ?? []) {
      const st = String(r.RunDetailSummary?.Status ?? "");
      if (["STARTING", "QUEUED", "RUNNING"].includes(st) && r.RunId) {
        try {
          await c.send(new StopWorkflowRunCommand({ WorkflowArn: workflowArn, RunId: r.RunId }));
          stoppedRuns++;
        } catch {
          /* best-effort */
        }
      }
    }
  } catch (e) {
    if (!/ResourceNotFound/i.test(String((e as Error)?.name ?? "") + String((e as Error)?.message ?? ""))) throw e;
    return { deleted: true, stoppedRuns };
  }
  // 🔴 Stop 之后**必须等 run 真到终态**再删。
  //   服务对「还有 run 没停」的 DeleteWorkflow 会拒;原版停完立刻删 ⇒ 有 run 在跑时下线必失败,
  //   而上层把异常吞成 skipped 且照样清台账 ⇒ **孤儿 workflow 继续按 cron 跑,平台再也删不掉它**(真环境已留下 4 个)。
  const NON_TERMINAL = ["STARTING", "QUEUED", "RUNNING", "STOPPING"];
  for (let i = 0; i < 24; i++) {
    let busy: string[] = [];
    try {
      const rs = await c.send(new ListWorkflowRunsCommand({ WorkflowArn: workflowArn }));
      busy = (rs.WorkflowRuns ?? [])
        .filter((r) => NON_TERMINAL.includes(String(r.RunDetailSummary?.Status ?? "")))
        .map((r) => `${r.RunId}:${r.RunDetailSummary?.Status}`);
    } catch (e) {
      if (/ResourceNotFound/i.test(String((e as Error)?.name ?? "") + String((e as Error)?.message ?? ""))) return { deleted: true, stoppedRuns };
      throw e;
    }
    if (busy.length === 0) break;
    if (i === 23) throw new Error(`workflow 还有未停止的 run,${(24 * 5) / 60} 分钟内没到终态,拒绝当成已下线:${busy.join(" / ")}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      await c.send(new DeleteWorkflowCommand({ WorkflowArn: workflowArn }));
      return { deleted: true, stoppedRuns };
    } catch (e) {
      if (/ResourceNotFound/i.test(String((e as Error)?.name ?? "") + String((e as Error)?.message ?? ""))) return { deleted: true, stoppedRuns };
      lastErr = e;
      if (!/Conflict|in a state|InvalidRequest/i.test(String((e as Error)?.name ?? "") + String((e as Error)?.message ?? ""))) throw e;
      await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));   // 冲突 = 服务还在收尾,退避重试
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getWorkflow(region: string, workflowArn: string) {
  return serverlessClientFor(region).send(new GetWorkflowCommand({ WorkflowArn: workflowArn }));
}
export async function startWorkflowRun(region: string, workflowArn: string,
                                      opts: { attempts?: number; intervalMs?: number } = {}) {
  // 🔴 单一作者:重试放在**这里**,三个调用点(手动触发路由 / scheduler/trigger / 下游依赖)一起受益。
  //   放在任一调用点里 = 另外两条路径照旧假红(「写了 ≠ 接上了」那一类)。
  const attempts = opts.attempts ?? 5;
  const intervalMs = opts.intervalMs ?? 12_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await serverlessClientFor(region).send(new StartWorkflowRunCommand({ WorkflowArn: workflowArn }));
    } catch (e) {
      lastErr = e;
      if (!isTransientRoleNotAssumable(e) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  // 窗口用完仍是这个错 ⇒ 照原样抛,但把「已经等过多久」写进人话,免得被当成配置错去查信任策略。
  if (isTransientRoleNotAssumable(lastErr)) {
    throw new Error(`执行角色刚建好、airflow-serverless 侧仍在传播,等了 ${attempts} 次 × ${intervalMs / 1000}s 仍被拒`
      + `(信任策略本身没问题,过一两分钟再触发即可)。原文:${String((lastErr as Error)?.message ?? lastErr)}`);
  }
  throw lastErr;
}
/** 最近的 run 列表(任务日志按时间窗对台账行;最多一页)。 */
export async function listWorkflowRuns(region: string, workflowArn: string, maxResults = 20) {
  const r = await serverlessClientFor(region).send(new ListWorkflowRunsCommand({ WorkflowArn: workflowArn, MaxResults: maxResults }));
  return r.WorkflowRuns ?? [];
}
export async function getWorkflowRun(region: string, workflowArn: string, runId: string) {
  return serverlessClientFor(region).send(new GetWorkflowRunCommand({ WorkflowArn: workflowArn, RunId: runId }));
}
export async function listTaskInstances(region: string, workflowArn: string, runId: string) {
  return serverlessClientFor(region).send(new ListTaskInstancesCommand({ WorkflowArn: workflowArn, RunId: runId }));
}
export async function getTaskInstance(region: string, workflowArn: string, runId: string, taskInstanceId: string) {
  return serverlessClientFor(region).send(new GetTaskInstanceCommand({ WorkflowArn: workflowArn, RunId: runId, TaskInstanceId: taskInstanceId }));
}
