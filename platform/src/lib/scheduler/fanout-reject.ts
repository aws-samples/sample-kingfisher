/**
 * 扇出的**接缝**:「逐 target 各自 try」之后,怎么把 N 个拒因合成**一个仍然可分派**的错误,
 * 以及单区扇出的响应怎么与扇出前**逐字兼容**。
 *
 * 🔴🔴 为什么要有这个文件(2026-09-16 段 slsw 真环境抓到):把发布/触发改成逐区扇出时,
 *   「一个区都没成」那一支写的是 `new Error(聚合文本)` —— 它把**类型化拒因**抹平成裸 Error,
 *   于是路由里那几条 `instanceof` 分派**全部落空**:
 *     · `ServerlessNodeUnsupported`(这张图里有 external 节点,服务侧表达不了 ⇒ 400「改图」)
 *       → 变成 **500**「平台故障」;实测 N-3 就是这么红的。
 *     · `MwaaNotInstalled`(那个区没装调度器 ⇒ 409 + **补装直达链接**)
 *       → 变成 **500**,用户连「去哪补装」这个出路都拿不到。
 *   500 的语义是「平台坏了,重试也许能好」,而这两类的真相是「不改图 / 不补装,重试一万次也不会好」。
 *   ⇒ 聚合**不许**新建裸 Error:把那个**原始**拒因原样抛出去(instanceof 才立得住),
 *      逐区明细挂在 `fanoutPerTarget` 上一并回给界面(不丢东西)。
 *
 * 同族教训:`mock-hides-the-seam` / `unwired-code-is-unverified` —— 缺陷永远长在接缝上,
 * 两侧各自的单测都是绿的。
 */
import { NextResponse } from "next/server";
import { MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";
// 🔴 **type-only**:`workflow-yaml` 会拖进整套 serverless 运行时代码生成(runtime-py → run-groups),
//   而本模块只是个错误分类器,被每条路由 import。按 `code` 判(它是类上的字面量常量)⇒
//   既不加运行期依赖,也不会因为「同一个类被两份模块实例各加载一次」而让 instanceof 失灵。
import type { ServerlessNodeUnsupported } from "@/lib/scheduler/serverless/workflow-yaml";
/** `ServerlessNodeUnsupported` 的 code(与类上的字面量同源,单测拿真实例核对过) */
const SERVERLESS_NODE_UNSUPPORTED = "SERVERLESS_NODE_UNSUPPORTED";
// 发布期**落点一致性 / 作业引用**拒因 —— 作业不绑该区 / 项目不符 / 作业不存在 / 同步任务不绑该区
//   ⇒ 400「改图或改绑定」,不是 409「补装」,更不是 500。同样 type-only(job-node-spec 会拖进 DDB 与两个 spec 作者)。
import type { JobNodeUnbound } from "@/lib/workflow/job-node-spec";
const JOB_NODE_UNBOUND = "JOB_NODE_UNBOUND";

export type FanoutCause = { message?: string; code?: string } | Error | unknown;

/** 这个拒因是不是「带语义的」(有机器可读 code,或是 Error 的具体子类)—— 只有它能撑起状态码分派。 */
export function isTypedRejection(e: unknown): boolean {
  if (!e) return false;
  if ((e as { code?: unknown })?.code) return true;
  if (e instanceof Error && e.constructor !== Error) return true;
  return /dag-spec-invalid/.test(String((e as Error)?.message ?? ""));
}

/**
 * 逐区全失败 ⇒ 合成一个错误。
 * 🔴 规则:**优先原样返回第一个带语义的拒因**(保住 instanceof / code / 它自己的字段,
 *    例如 `MwaaNotInstalled.missing` —— 补装链接就是从它拼出来的);一个都没有才退化成聚合文本。
 *    两种情况下都把 `fanoutPerTarget` / `fanoutSummary` 挂上去,逐区明细不许丢。
 */
export function fanoutRejection<T>(
  causes: unknown[],
  perTarget: T[],
  summary: string
): Error & { fanoutPerTarget?: T[]; fanoutSummary?: string; code?: string } {
  const typed = causes.find((c) => isTypedRejection(c));
  const anyError = causes.find((c) => c instanceof Error) as Error | undefined;
  const base: Error = typed instanceof Error ? typed : anyError ?? new Error(summary);
  const err = base as Error & { fanoutPerTarget?: T[]; fanoutSummary?: string; code?: string };
  const typedCode = (typed as { code?: string } | undefined)?.code;
  if (!err.code && typedCode) err.code = String(typedCode);
  err.fanoutPerTarget = perTarget;
  err.fanoutSummary = summary;
  return err;
}

/**
 * 调度类拒因 → HTTP 响应(**单一作者**)。回 `undefined` = 我不认识它,交给调用方兜 500。
 * 与 `residencyErrorResponse` / `runGroupWriteErrorResponse` 同款形状。
 */
export function schedulerRejectResponse(
  e: unknown,
  extra?: Record<string, unknown>
): NextResponse | undefined {
  const perTarget = (e as { fanoutPerTarget?: unknown })?.fanoutPerTarget;
  const detail = {
    ...(perTarget ? { perTarget } : {}),
    ...(extra ?? {}),
  };
  const hasDetail = Object.keys(detail).length > 0;
  // 那个区没装调度器 ⇒ 409 + 补装直达(链接来自 e.missing,所以**必须**是原始那个对象)
  if (e instanceof MwaaNotInstalled) {
    const r = mwaaErrorResponse(e);
    return r as unknown as NextResponse;
  }
  // 这张图里有服务侧表达不了的节点 ⇒ 400「改图」,不是 409「补装」,更不是 500「平台坏了」
  if ((e as { code?: string })?.code === SERVERLESS_NODE_UNSUPPORTED) {
    const u = e as ServerlessNodeUnsupported;
    return NextResponse.json(
      { success: false, error: { code: u.code, message: u.message, nodeTypes: u.types }, ...(hasDetail ? detail : {}) },
      { status: 400 }
    );
  }
  // 离线作业 / 同步节点在发布期不满足落点一致性(或作业不存在 / 项目不符)⇒ 400 点名节点与作业
  if ((e as { code?: string })?.code === JOB_NODE_UNBOUND) {
    const u = e as JobNodeUnbound;
    return NextResponse.json(
      {
        success: false,
        error: { code: u.code, message: u.message, nodeId: u.nodeId, nodeType: u.nodeType, reason: u.reason, ref: u.ref, targetId: u.targetId },
        ...(hasDetail ? detail : {}),
      },
      { status: 400 }
    );
  }
  const msg = String((e as Error)?.message ?? "");
  if ((e as { code?: string })?.code === "engine-capability" || msg.includes("dag-spec-invalid")) {
    return NextResponse.json({ error: msg, ...(hasDetail ? detail : {}) }, { status: 400 });
  }
  return undefined;
}

/**
 * 扇出成功响应体(**单一作者**)。
 * 🔴 扇出必须与「扇出之前」逐字兼容:那时候的响应是 `{success, dagId, scheduler, serviceRunId|runId}`,
 *   把这些事实整体搬进 `runs[]` ⇒ **所有老消费者(界面/脚本/下游依赖)读到的是 undefined**
 *   —— 症状是「点了触发、接口 200、而谁都找不到这次运行」。
 * ⇒ 顶层**摊平第一条 run**,与离线作业侧那条已经跑了很久的扇出**同一个约定**
 *   (`etl-jobs/[id]/run`:「顶层仍摊平第一条 run(存量调用方读的是 data.runId),多区结果在 runs 里」)。
 *   同一个概念两种响应形状 = 迟早漂移(change-safety A1),所以这里刻意抄它,不另发明。
 *   多区时真相在 `runs[]` + `runGroupId`(它们**恒在**),顶层那份只是兼容层。
 */
export function fanoutRunBody(args: {
  dagId: string;
  runs: Array<Record<string, unknown>>;
  runGroupId?: string;
  failures?: Array<Record<string, unknown>>;
  message?: string;
}): Record<string, unknown> {
  const { dagId, runs, runGroupId, failures } = args;
  return {
    success: true,
    dagId,
    ...(runs[0] ?? {}),
    runs,
    ...(runGroupId ? { runGroupId } : {}),
    ...(failures && failures.length ? { failures } : {}),
    message: args.message ?? (runs.length > 1 ? `已在 ${runs.length} 个执行范围各触发一次` : "已触发运行"),
  };
}

/**
 * 给拒因加上「哪个区」的前缀,**但不丢它的语义**。
 * 🔴 原来这里是 `new Error(\`触发失败(…): \${err.message}\`)` —— 把 `code` 一并丢了,
 *   于是上面那条「拒因一致就把 code 抬到顶层」永远拿不到 `SCHEDULER_ARTIFACT_MISSING`
 *   (紧挨着它的注释还写着「机器可读的拒因**必须保住**」—— 写了,但接缝上被抹平了)。
 *   后果:产物丢了本该回 409 +「请先重新发布一次」,实际回 500「平台故障」。
 */
export function tagFanoutFailure(e: unknown, targetId: string, region?: string): Error {
  // 具体子类(MwaaNotInstalled / ServerlessNodeUnsupported…)原样抛:instanceof 要立得住,
  // 而它们的文本本来就自带区域信息。
  if (e instanceof Error && e.constructor !== Error && isTypedRejection(e)) return e;
  const code = (e as { code?: string })?.code;
  const msg = `触发失败(${targetId}${region ? `/${region}` : ""}): ${String((e as Error)?.message ?? e)}`;
  return Object.assign(new Error(msg), code ? { code } : {});
}
