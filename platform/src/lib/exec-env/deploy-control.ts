// @kf-batch 50-P50.2c-control-api
// 执行环境部署的**平台侧接线**(50 SPEC §2.1 deploy/build-status;DESIGN §12.0/§12.4)。
//
// 【本文件的三条承重】
// ① **平台不直接碰 CodeBuild 的 StartBuild** —— 只 `lambda:InvokeFunction` 窄权 broker
//    (IR-P0-05:StartBuild 自带 buildspecOverride 等攻击向量,平台 ECS 角色根本没有该权限,
//    见 infra/lib/platform-stack.ts 的 ExecEnvDeployViaBrokerOnly 语句);
// ② **平台侧零状态写**:部署锁与 `status→initializing` 都发生在 broker(DESIGN:549 —— 锁放调用方
//    一侧,任何直接 invoke broker 的人都能绕过它)。本文件只读;
// ③ **逐栈进度来自目标 region 的 CloudFormation**(DESIGN §12.4 定案):`BatchGetBuilds` 只给
//    "build 整体在跑/成功/失败"的粗粒度 —— cdk deploy 全程在单个 BUILD phase 里,phases[] 给不了逐栈。
import { homeRegion } from "@/lib/place/home-region";
import { explainCfnFailure } from "@/lib/exec-env/cfn-failure";
import { LambdaClient, InvokeCommand, GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { CodeBuildClient, BatchGetBuildsCommand, BatchGetProjectsCommand, ListBuildsForProjectCommand } from "@aws-sdk/client-codebuild";
import { CloudFormationClient, DescribeStacksCommand, ListChangeSetsCommand, DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { execEnvStackName } from "@/lib/aws/naming";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
// @kf-batch 50-WP31-seq5-dataplane-role —— 散建收口到唯一工厂(序 5:数据面凭证注入点只有这一处)
import { sdkClient } from "@/lib/aws/clients";
// @kf-batch 50-WP31-place-first-class 序 31 第二刀 ②:逐栈进度查的是**目标区**的 CloudFormation(控制面服务,但客户端不在主控区
//   ⇒ 观测器不豁免);GET build-status 路由没有任何一笔决策 ⇒ 未归因。读取进度 = 替这个 target 做事,在唯一作者这里记账。
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名。 */
export const BUILD_STATUS_PLACE_VIA = "readBuildStatus";

/**
 * broker 函数名 / CodeBuild 项目名。
 * 🔴 与 `infra/lib/exec-env/deploy-stack.ts` 导出的 EXEC_ENV_BROKER_NAME / EXEC_ENV_PROJECT_NAME
 * 是**同一个字面量**,靠 `__tests__/deploy-control.test.ts` 的契约测试(readFileSync infra 源码逐字比对)
 * 钉住 —— 两侧跨构建边界无法共享常量,与 naming.json 双侧出口同一处境。
 */
export const EXEC_ENV_BROKER_NAME = "bgp-exec-env-broker";
// 序 31 二刀 ⑤:项目名(与其日志组名)搬进零 import 叶子 `exec-env-project-name.ts` —— 落点观测器据它把「读执行环境部署日志」
//   判成控制面(它在 instrumentation 可达面上,不能 import 本文件的 AWS SDK);这里 re-export,既有 import 路径零改动。
import { EXEC_ENV_PROJECT_NAME } from "@/lib/exec-env/exec-env-project-name";
export { EXEC_ENV_PROJECT_NAME };

/**
 * 🔴 P50.3b-2b:CodeBuild 项目的 **build 超时**(= `infra/lib/exec-env/deploy-stack.ts` 的
 * `timeout: cdk.Duration.hours(2)`,由 `__tests__/deploy-control.test.ts` 读 infra 源码逐字钉住)。
 *
 * 【为什么平台侧需要知道它】`startUncertain`(broker 开了 operation 但 StartBuild 结果未知)时**没有 buildId 可查**,
 * 恢复端点无法用"查那次 build 是否终止"来证明安全。唯一**结构性**的证明是:CodeBuild 到 `timeoutInMinutes`
 * 必杀 build ⇒ 距 `operation.startedAt` 超过它之后,那次会话**不可能**还有 build 在跑(SPEC §3.5b ③)。
 * 🔴 这是"不猜"的下界,不是拍脑袋的等待时间;API/UI 据它回报 `earliestRecoverAt`。
 */
export const EXEC_ENV_BUILD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * CodeBuild 的**失败终态**词表 = broker `TERMINAL_BUILD_STATUS` 去掉 `SUCCEEDED`
 * (成功要走完成 fence,不是恢复 —— 见 SPEC §3.5b ③)。跨构建边界由
 * `__tests__/deploy-control.test.ts` 读 broker 源码逐字钉住(同 EXEC_ENV_BROKER_NAME 先例)。
 */
export const TERMINAL_FAILED_BUILD_STATUSES = ["FAILED", "FAULT", "TIMED_OUT", "STOPPED"] as const;

export function isTerminalFailedBuildStatus(phase: string): boolean {
  return (TERMINAL_FAILED_BUILD_STATUSES as readonly string[]).includes(phase);
}

/** CodeBuild 里**查不到**该 buildId(记录被清理 / 项目被重建)。⇒ 没有 build 在跑,但也不是"失败终止"。 */
export const BUILD_NOT_FOUND = "not-found";

/**
 * 🔴 P50.3b-2b:**恢复路专用**的 exact build 终态读取器。
 *
 * 【为什么不复用 `readBuildStatus`】① 它顺带并发拉**逐栈 DescribeStacks + 日志尾巴**,恢复判定一个都不要,
 *   纯浪费(每次开详情页都打一圈);更要紧的是它那份 `stacks` 是**会降级成 UNKNOWN 的那一版**,
 *   将来有人顺手读它就等于把 `describeStackDisposition` 的 fail-closed 闸换成 fail-open。
 * ② 它把"查不到 build"和"没传 buildId"都压成 `phase:"none"`,而恢复判定必须区分:
 *   `NOT_FOUND` 证明**没有 build 在跑**(记录都没了),该会话可以恢复;`"none"` 却会被当成"状态未定"
 *   ⇒ 锁永远解不开(又一个"永久卡死"门,与本批要根治的是同一类)。
 */
export async function readExactBuildPhase(buildId: string): Promise<string> {
  const out = await codeBuildClient.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  const build = out.builds?.[0];
  if (!build) return BUILD_NOT_FOUND; // buildsNotFound:CodeBuild 明确说"没有这个 build"
  return build.buildStatus ?? "UNKNOWN";
}

/**
 * 🔴 AWS 报错文案脱敏(**红线:账号号必脱敏**)。恢复闸的 blockers 会经 HTTP 响应 + 审计外泄,
 * 而 AccessDenied 一类的原文里带 12 位账号号与完整 role ARN。只保留"哪类错误",抹掉身份。
 */
export function sanitizeAwsErrorMessage(msg: string): string {
  return msg
    .replace(/arn:aws[a-z-]*:[^\s"']+/g, "<arn>")
    .replace(/\b\d{12}\b/g, "<account>")
    .slice(0, 160);
}

/**
 * `no-build`(startUncertain)恢复窗的裕度:项目超时之上再等一点。
 * 🔴 **必须 > broker 的 5min 同 token 重发窗**(`index.mjs` 的 `resumableUnattachedStart`):
 *    在窗末(startedAt+5min)才被重发出去的那个 build,直到 `startedAt+5min+项目超时` 才会被 CodeBuild 超时杀。
 *    取 15min ⇒ 覆盖重发窗 + 时钟偏斜,仍远小于一次真部署的观察周期。
 */
export const RECOVERY_NO_BUILD_MARGIN_MS = 15 * 60 * 1000;

/**
 * 🔴 `operation` 没有 buildId(startUncertain:open 成功但 StartBuild 结果未知)时的**结构性**安全窗
 * (SPEC §3.5b ③)。**唯一一处**做这个算术 —— reconciler(呈现)与 recover 路由(放行)必须用同一份,
 * 否则页面说"可以恢复了"而接口拒绝(或更糟:反过来)。
 *
 * 依据:CodeBuild 到 `timeoutInMinutes` 必杀 build ⇒ 距 `startedAt` 超过 `项目超时 + 裕度` 之后,
 * 那次会话**不可能**还有 build 在跑。`startedAt` 不可解析 ⇒ `recoverable:false`(fail-closed,不猜)。
 */
export function noBuildRecoveryWindow(
  startedAt: string,
  now: number = Date.now(),
  evidence?: NoBuildEvidence
): { earliestRecoverAt: string; recoverable: boolean; by?: "window" | "absence" } {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return { earliestRecoverAt: "", recoverable: false };
  }
  const earliestMs = startedMs + EXEC_ENV_BUILD_TIMEOUT_MS + RECOVERY_NO_BUILD_MARGIN_MS;
  if (now >= earliestMs) return { earliestRecoverAt: new Date(earliestMs).toISOString(), recoverable: true, by: "window" };
  // @kf-batch 50-WP15-airflow-serverless —— 🔴 第二条放行证据:**CodeBuild 项目里根本没有这次 operation 的 build**。
  //   结构窗(2h15m)是「StartBuild 结局未知」时的兜底;但 broker 在 open 之后、StartBuild 之前就停了(如 post-image 不匹配)的场景
  //   在真环境里发生了,而 ListBuildsForProject 能**正面证明**没有 build(StartBuild 成功的 build 会立即进列表)。
  //   为防与 broker 的 StartBuild 竞态,证据只在会话开始 ≥ START_ABSENCE_MIN_AGE_MS 后才算数;找到 build 则不走本分支(那是 attach 丢响应)。
  if (evidence?.absent === true && evidence.verifiedAt - startedMs >= START_ABSENCE_MIN_AGE_MS) {
    return { earliestRecoverAt: new Date(earliestMs).toISOString(), recoverable: true, by: "absence" };
  }
  return { earliestRecoverAt: new Date(earliestMs).toISOString(), recoverable: false };
}

/** 会话开始多久之后「列表里没有该 operation 的 build」才可信(broker Lambda 超时 30s;取 5min 覆盖时钟偏斜 / 列表最终一致)。 */
export const START_ABSENCE_MIN_AGE_MS = 5 * 60 * 1000;

export interface NoBuildEvidence {
  /** true = 翻遍会话开始之后的 build 列表,没有一个 build 的 EXEC_ENV_OPERATION_ID 等于该 operation */
  absent: boolean;
  /** 找到的话:那次 build 的 id 与状态(= attach 丢响应的候选) */
  candidateBuildId?: string;
  candidateStatus?: string;
  /** 证据采集时刻 */
  verifiedAt: number;
}

/**
 * @kf-batch 50-WP15-airflow-serverless —— 在 exec-env CodeBuild 项目里找「带 EXEC_ENV_OPERATION_ID = operationId」的 build。
 * 只翻会话开始(startedAt − 5min)之后的 build(列表按开始时间倒序,翻到更早的就停),每批 ≤ 100 个 BatchGetBuilds。
 * 🔴 查询失败一律**不给** absent=true(fail-closed:查不到 ≠ 没有)。
 */
export async function verifyNoBuildForOperation(operationId: string, startedAt: string, now: number = Date.now()): Promise<NoBuildEvidence> {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return { absent: false, verifiedAt: now };
  const floorMs = startedMs - START_ABSENCE_MIN_AGE_MS;
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const list = await codeBuildClient.send(new ListBuildsForProjectCommand({ projectName: EXEC_ENV_PROJECT_NAME, sortOrder: "DESCENDING", ...(nextToken ? { nextToken } : {}) }));
    const ids = list.ids ?? [];
    if (ids.length === 0) break;
    const got = await codeBuildClient.send(new BatchGetBuildsCommand({ ids }));
    let reachedFloor = false;
    for (const b of got.builds ?? []) {
      const started = b.startTime ? new Date(b.startTime).getTime() : undefined;
      if (started !== undefined && started < floorMs) {
        reachedFloor = true;
        continue;
      }
      const env = b.environment?.environmentVariables ?? [];
      if (env.some((e) => e.name === "EXEC_ENV_OPERATION_ID" && e.value === operationId)) {
        return { absent: false, candidateBuildId: b.id, candidateStatus: b.buildStatus ?? "UNKNOWN", verifiedAt: now };
      }
    }
    if (reachedFloor || !list.nextToken) break;
    nextToken = list.nextToken;
  }
  return { absent: true, verifiedAt: now };
}

const HOME_REGION = homeRegion();

// broker 与 CodeBuild 都在 home region(控制面单份);CloudFormation client 按 target.region 现建。
const lambdaClient = sdkClient("control-plane", LambdaClient, { region: HOME_REGION });
const codeBuildClient = sdkClient("control-plane", CodeBuildClient, { region: HOME_REGION });

/** broker 的响应形状(infra/lambda/exec-env-broker/index.mjs 的 handler 返回值)。 */
export type BrokerResult =
  | { ok: true; buildId: string; lockEpoch: number; targetId: string; region: string; warning?: string }
  | { ok: false; code: string; message: string };

/**
 * broker 拒绝码 → HTTP 状态。
 * 🔴 只映射 broker **自己定义**的码;没见过的码一律 502(broker 行为变了 = 上游契约漂移,
 * 不该被平台猜成 4xx 让调用方背锅)。
 */
export function brokerCodeToHttp(code: string): number {
  switch (code) {
    case "locked":
      return 409; // 部署锁被占:同 target 并发 deploy(§12.2 P0-C)
    case "bad-status":
      return 409; // draining/decommissioning 等不可部署状态
    case "not-registered":
      return 404;
    case "rejected":
      return 400; // 入参白名单/格式被拒
    case "bad-descriptor":
      return 500; // 注册表 item 缺 region/accountId —— 数据坏了,不是调用方的错
    // 🔴 P50.3b(审核 §19.7)新增的四个分类码:都是"有在途/陈旧会话,先按既定路收口"⇒ 冲突语义 409;
    //    落 default 502 会把"该走 finalize/恢复"误报成上游故障(拒因即解释,不能糊成 502)。
    case "needs-finalize":
    case "needs-legacy-finalize":
    case "needs-failure-reconcile":
    case "needs-fresh-probe":
      return 409;
    default:
      return 502;
  }
}

/**
 * 触发部署:invoke broker(白名单三参,别的一概不传 —— broker 收到未知字段会拒,这是特性不是限制)。
 * Lambda 调用失败(网络/权限/函数不存在)与 broker 明确拒绝**分开**:前者抛错(让 route 走 502),
 * 后者返回 `{ok:false}` 由 route 按 code 映射状态码。
 */
export async function invokeDeployBroker(
  targetId: string,
  components: string[],
  operationId: string,
  /**
   * 🔴 P0-E(SPEC §3.5c):可选的两个入参,**只在需要时带**。
   *   · `mode: "preview"` ⇒ 只出裁决不部署(broker 走只读旁路:不开 operation、不上锁、不涨 epoch);
   *   · `approvedPlanHash` ⇒ build 侧闸拿它与**本地重算**的 planHash 逐字节比对。
   * 🔴 broker 的入参白名单只有 5 个字段(targetId/components/operationId/mode/approvedPlanHash);
   *    多传一个就被拒 —— 这是特性不是限制(override 攻击面的入口在这里)。
   *    `undefined` 的字段**不进 payload**(JSON.stringify 会丢掉它们)⇒ 老调用方行为逐字不变。
   */
  opts?: { mode?: "deploy" | "preview"; approvedPlanHash?: string }
): Promise<BrokerResult> {
  let out;
  try {
    out = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: EXEC_ENV_BROKER_NAME,
        Payload: Buffer.from(
          JSON.stringify({
            targetId,
            components,
            operationId,
            ...(opts?.mode ? { mode: opts.mode } : {}),
            ...(opts?.approvedPlanHash ? { approvedPlanHash: opts.approvedPlanHash } : {}),
          })
        ),
      })
    );
  } catch (e) {
    // @kf-batch 50-init-deploy-mechanism —— 「部署机制没装」翻译成可执行的话(其余不可达形态原样透出)
    throw describeBrokerInvokeFailure(e);
  }
  // FunctionError = broker 自身未捕获异常(它的 handler 全 try/catch,出现这个说明 broker 部署坏了)
  if (out.FunctionError) {
    throw new Error(`broker 执行异常(FunctionError=${out.FunctionError})—— broker 本身故障,非业务拒绝`);
  }
  const raw = out.Payload ? Buffer.from(out.Payload).toString("utf8") : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`broker 响应不是 JSON(前 200 字:${raw.slice(0, 200)})`);
  }
  const r = parsed as Partial<BrokerResult> & { ok?: unknown };
  // 🔴 形状校验 fail-closed:缺 ok 字段不猜成功也不猜失败,报上游契约漂移。
  if (typeof r?.ok !== "boolean") {
    throw new Error(`broker 响应缺 ok 字段 —— broker 契约漂移(收到:${raw.slice(0, 200)})`);
  }
  if (r.ok === true && (typeof r.buildId !== "string" || r.buildId.length === 0)) {
    throw new Error("broker 报成功但没给 buildId —— broker 契约漂移");
  }
  return parsed as BrokerResult;
}

// @kf-batch 50-init-deploy-mechanism
/**
 * 🔴 broker **不可达**的诸多形态里,`ResourceNotFoundException`(Function not found)= 「部署机制根本没装」。
 *   2026-09-06 新账号真跑:deploy-all 21 栈全绿、向导注册成功、「开始部署」报 `Function not found: <arn>`——
 *   原文只有一串 ARN,离根因(控制面栈 BgpExecEnvDeployStack 未部署)与修法很远。这里翻译成可执行的话;
 *   其余形态(网络 / 权限 / 限流)原样透出,不猜。
 */
export const DEPLOY_MECHANISM_MISSING_CODE = "DEPLOY_MECHANISM_MISSING";
export const DEPLOY_MECHANISM_MISSING_HINT =
  `执行环境部署机制未就位:窄权 broker Lambda ${EXEC_ENV_BROKER_NAME} 不存在(控制面栈 BgpExecEnvDeployStack 未部署)。` +
  `运维修复:bash scripts/redeploy-platform.sh <profile> <region>(§2b 会一并部署该栈;deploy-all 第 6.5 步亦已收编)`;

export function describeBrokerInvokeFailure(e: unknown): Error {
  const name = (e as { name?: string })?.name ?? "";
  const msg = String((e as Error)?.message ?? e);
  if (name === "ResourceNotFoundException" || /Function not found/i.test(msg)) {
    const err = new Error(DEPLOY_MECHANISM_MISSING_HINT) as Error & { code?: string };
    err.code = DEPLOY_MECHANISM_MISSING_CODE;
    return err;
  }
  return e instanceof Error ? e : new Error(msg);
}

/**
 * 接线体检用:部署机制(broker Lambda + CodeBuild 项目)是否**真在**。两次只读调用
 * (`lambda:GetFunctionConfiguration` / `codebuild:BatchGetProjects`,TaskRole 的 ExecEnvControl 只放这两个 ARN)。
 * 不 invoke broker:invoke 会写审计 / 走白名单校验,体检不该有副作用。
 */
export async function probeDeployMechanism(): Promise<{ ok: boolean; detail: string }> {
  const parts: string[] = [];
  let ok = true;
  try {
    const fn = await lambdaClient.send(new GetFunctionConfigurationCommand({ FunctionName: EXEC_ENV_BROKER_NAME }));
    parts.push(`broker ${EXEC_ENV_BROKER_NAME} 在(${fn.Runtime ?? "?"},更新于 ${fn.LastModified ?? "?"})`);
  } catch (e) {
    ok = false;
    parts.push(`broker ${EXEC_ENV_BROKER_NAME} 不可达:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e))}`);
  }
  try {
    const pj = await codeBuildClient.send(new BatchGetProjectsCommand({ names: [EXEC_ENV_PROJECT_NAME] }));
    if (pj.projects?.[0]?.name === EXEC_ENV_PROJECT_NAME) parts.push(`CodeBuild 项目 ${EXEC_ENV_PROJECT_NAME} 在`);
    else {
      ok = false;
      parts.push(`CodeBuild 项目 ${EXEC_ENV_PROJECT_NAME} 不存在`);
    }
  } catch (e) {
    ok = false;
    parts.push(`CodeBuild 项目查询失败:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e))}`);
  }
  return { ok, detail: parts.join(" · ") };
}

/** SPEC §2.1 build-status 的响应形状:`{phase, stacks:[{name,status}], logsTail, observedVersion}`。 */
export interface BuildStatus {
  /** CodeBuild 整体粗粒度(IN_PROGRESS/SUCCEEDED/FAILED/…);无 build 时 "none"。 */
  phase: string;
  /** 逐栈状态,来自**目标 region** 的 CloudFormation(DESIGN §12.4)。 */
  stacks: Array<{ name: string; status: string }>;
  /** 构建日志尾部(最多 20 行);任何环节失败降级为 ""(进度页不该因日志拉取失败而整体 500)。 */
  logsTail: string;
  /**
   * ⬜ 恒 null:observed 版本的真源是**切片 e 的描述符回写**(desired/observed reconcile,SPEC §1.1)。
   * 字段保留在形状里(SPEC §2.1 合同),值如实为 null,不装完成。
   */
  observedVersion: null;
}

/**
 * 读部署进度(SPEC §2.1 GET build-status)。
 *
 * @param target 注册表 item(管理面 raw 读;需要 targetId/region)
 * @param buildId 本次要看的 build;缺省取 `target.lastBuildId`(broker 置 initializing 时写入)
 */
export async function readBuildStatus(target: ExecutionTarget, buildId?: string): Promise<BuildStatus> {
  notePlaceDecision({ targetId: target.targetId, via: BUILD_STATUS_PLACE_VIA }); // 第一个 await 之前(D11)
  const effectiveBuildId = buildId ?? (target as { lastBuildId?: string }).lastBuildId;
  const [build, stacks] = await Promise.all([
    effectiveBuildId ? fetchBuild(effectiveBuildId) : Promise.resolve(undefined),
    fetchStackStatuses(target),
  ]);
  const logsTail = build ? await fetchLogsTail(build) : "";
  return {
    phase: build?.buildStatus ?? "none",
    stacks,
    logsTail,
    observedVersion: null,
  };
}

interface BuildLite {
  buildStatus?: string;
  logs?: { groupName?: string; streamName?: string };
}

async function fetchBuild(buildId: string): Promise<BuildLite | undefined> {
  const out = await codeBuildClient.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  return out.builds?.[0] as BuildLite | undefined;
}

/**
 * 目标 region 的逐栈状态。
 *
 * 🔴 **P50.2f 改为「按命名 SSOT 推定栈名、逐栈指名查询」**(销掉无参列举):
 *    切片 f 把平台角色的 DescribeStacks 从 `Resource:*` 收窄到 `stack/BgpExecEnv-*` —— 资源级授权下
 *    **无参列举整个 region 会被 AccessDenied**,原实现会把它当"降级"吞成 stacks:[],进度页栈级明细
 *    静默消失(第三个跨切片接缝:f 的 IAM × e 的代码)。指名查询的 ARN 落在 BgpExecEnv-* 内 ⇒ 可行,
 *    且**不再需要前缀过滤**(名字本来就是我们按 SSOT 推定的)。
 *    栈清单 = base ∪ core ∪ 已装组件 ∪ spec.desiredComponents(`candidateStackNames` 单一作者;补充部署期间新栈也要列出)。
 * 🔴 "栈还不存在"(部署刚开始)的指名调用抛 ValidationError("does not exist")⇒ 按「尚未创建」跳过,
 *    不是错误;其它错误(region 未 bootstrap / IAM 未扩)降级为该栈 UNKNOWN 并留痕,不整体 500。
 */
/**
 * 🔴 候选栈名的**唯一作者**(进度页 `fetchStackStatuses` 与清锁闸 `describeStackDisposition` 共用):
 *   = `base` ∪ `core` ∪ 顶层 `components`(observed,只在真读到 Outputs 后才写)∪ `spec.desiredComponents`(desired)。
 * 【为什么进度页也要并上 desired(2026-09-05 真环境 W5a-11 抓到)】补充部署 residency-api 期间,新栈**已 CREATE_COMPLETE**,
 *   进度页却只列 base/core/redshift 三栈 —— 因为它只按 observed 组件推名;正在创建的那个栈恰恰是用户最想看的。
 *   两处各写一遍推名就会像这样漂移,故抽成一处。栈名仍走命名 SSOT(`execEnvStackName`),零新硬编码。
 */
export function candidateStackNames(target: ExecutionTarget): string[] {
  const observed = Array.isArray(target.components) ? (target.components as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const specDesired = (target as { spec?: { desiredComponents?: unknown } }).spec?.desiredComponents;
  const desired = Array.isArray(specDesired) ? (specDesired as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const componentSet = Array.from(new Set(["core", ...observed, ...desired]));
  return Array.from(new Set(["base", ...componentSet].map((c) => execEnvStackName(target.targetId, c))));
}

async function fetchStackStatuses(target: ExecutionTarget): Promise<Array<{ name: string; status: string }>> {
  const candidates = candidateStackNames(target);
  const cfn = sdkClient("control-plane", CloudFormationClient, { region: target.region });
  const found: Array<{ name: string; status: string }> = [];
  await Promise.all(
    candidates.map(async (name) => {
      try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
        const st = out.Stacks?.[0];
        if (st?.StackName) found.push({ name: st.StackName, status: st.StackStatus ?? "UNKNOWN" });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/does not exist/i.test(msg)) return; // 尚未创建:部署刚开始的正常窗口
        console.error("[exec-env/deploy-control] DescribeStacks(%s@%s)失败,该栈标记 UNKNOWN:%s",
          name, target.region, msg);
        found.push({ name, status: "UNKNOWN" });
      }
    })
  );
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 🔴 P50.3b-2a:观测态模板版本(`observed.templateVersion` 真写入方,复活 SPEC §1.1 死字段;周期 reconciler 调)。
 * = 目标 region 的 `BgpExecEnv-*` 栈中**最近一次更新时间**(`LastUpdatedTime ?? CreationTime` 的最大 ISO)——
 * "当前部署的基础设施最后一次变更于何时"的**真实观测**(desired/observed 模板漂移会体现为时间差)。
 * 🔴 **best-effort**:任一栈失败 / 尚未创建 / 无栈 ⇒ 忽略该栈;全无 ⇒ 返回 undefined
 * (reconcileTelemetry 只在有值时写,绝不写假值 —— 与 build-status 的 `observedVersion:null` 同一"不装完成"原则)。
 * 复用 fetchStackStatuses 同款「按命名 SSOT 逐栈指名 DescribeStacks」(资源级 IAM 下不能无参列举,§12.1)。
 */
export async function describeObservedTemplateVersion(target: ExecutionTarget): Promise<string | undefined> {
  const components = Array.isArray(target.components) && target.components.length > 0 ? target.components : ["core"];
  const candidates = ["base", ...components].map((c) => execEnvStackName(target.targetId, c));
  const cfn = sdkClient("control-plane", CloudFormationClient, { region: target.region });
  let latestMs: number | undefined;
  await Promise.all(
    candidates.map(async (name) => {
      try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
        const st = out.Stacks?.[0];
        const ts = st?.LastUpdatedTime ?? st?.CreationTime;
        if (ts) {
          const ms = ts.getTime();
          if (latestMs === undefined || ms > latestMs) latestMs = ms;
        }
      } catch {
        /* 尚未创建 / region 未 bootstrap / 权限 ⇒ best-effort 忽略该栈 */
      }
    })
  );
  return latestMs === undefined ? undefined : new Date(latestMs).toISOString();
}

/**
 * 🔴 P50.3b-2b:**恢复闸专用**的目标 region 基础设施处置(SPEC §3.5b ④)。
 *
 * 【与 `fetchStackStatuses`(进度页)的关键差别 —— 这是两个函数而不是加一个参数的原因】
 *   进度页把 DescribeStacks 失败**降级**成 `UNKNOWN` 继续显示(权限抖动不该让进度接口 500);
 *   本闸**绝不降级** —— 它要回答的是"现在清掉部署锁安全吗",**看不清就等于不安全**(fail-closed)。
 *   混用会造成:describe 因权限/网络失败 → 被当成"没有在进行的动作" → 清锁 → 第二次部署撞上还在跑的 CFN。
 *
 * 【栈清单必须取并集】失败的那个栈往往是**新组件**的栈,它还没进 `components`(observed 只在真读到 Outputs 后才写)。
 *   只查 observed 会**漏掉正在创建/回滚中的那一个** = fail-open。故 = `base` ∪ 顶层 `components` ∪ `spec.desiredComponents`。
 *   栈名仍走命名 SSOT(`execEnvStackName`),零新硬编码(避免 #7/#8/#10 那类"部署时快照"同族坑)。
 *
 * 判"不稳定"的四类(任一即 blocker):① 栈状态 `*_IN_PROGRESS`(含 `REVIEW_IN_PROGRESS`)② 存在**未执行**的
 * change set(P0-E 引入 changeset 预演后尤其重要)③ DescribeStacks 非"不存在"的失败 ④ ListChangeSets 失败。
 * "栈不存在"**不是** blocker(初装还没建栈就失败的正常形态)。
 */
export interface StackDisposition {
  checkedAt: string;
  stacks: Array<{ name: string; status: string; pendingChangeSets: number; failureReason?: string }>;
  /** 全部存在的栈都无进行中动作、无未执行 change set,且**没有任何一次查询失败**。 */
  stable: boolean;
  /** 不稳定的具体原因(逐条,给管理员看);stable 时为空数组。 */
  blockers: string[];
}

/**
 * 🔴 **允许清锁的栈终态白名单**(审核 §19.8 执行序第 3 步要求「无进行中动作**且已成功回滚/稳定**」)。
 *
 * 【为什么必须是白名单而不是"拦 `*_IN_PROGRESS`"】`UPDATE_ROLLBACK_FAILED` / `ROLLBACK_FAILED` /
 * `CREATE_FAILED` / `DELETE_FAILED` 都**不以 `_IN_PROGRESS` 结尾** —— 黑名单写法会把"CFN 明确告诉你
 * 没回滚成功"判成 stable 而放锁,正是该条要堵的场景(fail-open)。白名单则天然覆盖未来新增状态词。
 */
export const STABLE_STACK_STATUSES = [
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_COMPLETE",
  "DELETE_COMPLETE",
] as const;

/** change set 处于"已创建但尚未执行完"⇒ 基础设施随时可能被它改动 ⇒ 不稳定。 */
function isPendingChangeSet(cs: { Status?: string; ExecutionStatus?: string }): boolean {
  return (
    cs.ExecutionStatus === "AVAILABLE" ||
    cs.ExecutionStatus === "EXECUTE_IN_PROGRESS" ||
    cs.Status === "CREATE_PENDING" ||
    cs.Status === "CREATE_IN_PROGRESS"
  );
}

export async function describeStackDisposition(target: ExecutionTarget): Promise<StackDisposition> {
  const candidates = candidateStackNames(target); // 与进度页同一作者(见上)
  const cfn = sdkClient("control-plane", CloudFormationClient, { region: target.region });
  const stacks: StackDisposition["stacks"] = [];
  const blockers: string[] = [];

  await Promise.all(
    candidates.map(async (name) => {
      let status: string;
      try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
        const st = out.Stacks?.[0];
        if (!st?.StackName) {
          // 指名 describe 返回空 Stacks:形态异常,不敢当"不存在"处理(fail-closed)。
          blockers.push(`${name}:DescribeStacks 返回空(看不清 ⇒ 视为不安全)`);
          return;
        }
        status = st.StackStatus ?? "UNKNOWN";
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/does not exist/i.test(msg)) return; // 尚未创建:初装失败在建栈之前的正常形态,不是 blocker
        blockers.push(`${name}:DescribeStacks 失败(${sanitizeAwsErrorMessage(msg)})⇒ 看不清 ⇒ 视为不安全`);
        return;
      }

      let pendingChangeSets = 0;
      try {
        const cs = await cfn.send(new ListChangeSetsCommand({ StackName: name }));
        pendingChangeSets = (cs.Summaries ?? []).filter(isPendingChangeSet).length;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        blockers.push(`${name}:ListChangeSets 失败(${sanitizeAwsErrorMessage(msg)})⇒ 看不清 ⇒ 视为不安全`);
        return;
      }

      // @kf-batch 50-WP15-airflow-serverless(K-5):失败栈把**第一个**资源级失败原因带回页面(翻成人话;EIP 配额撞上时页面只见「部署失败」= 真因不可见)
      let failureReason: string | undefined;
      if (/ROLLBACK|FAILED/.test(status)) {
        try {
          const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: name }));
          const first = [...(ev.StackEvents ?? [])]
            .filter((x) => /_FAILED$/.test(x.ResourceStatus ?? "") && x.ResourceStatusReason && !/cancelled/i.test(x.ResourceStatusReason))
            .sort((x, y) => (x.Timestamp?.getTime() ?? 0) - (y.Timestamp?.getTime() ?? 0))[0];
          failureReason = explainCfnFailure(first ? `${first.LogicalResourceId ?? "?"}(${first.ResourceType ?? "?"}):${first.ResourceStatusReason}` : undefined);
        } catch {
          /* 读不到事件就不带原因;不影响稳定性判定 */
        }
      }
      stacks.push({ name, status, pendingChangeSets, ...(failureReason ? { failureReason } : {}) });
      if (!(STABLE_STACK_STATUSES as readonly string[]).includes(status)) {
        // 分开报因:进行中 vs 已终止但未成功回滚 —— 后者要人先去 CFN 把栈修回可用终态。
        blockers.push(
          status.endsWith("_IN_PROGRESS")
            ? `${name}:栈有进行中动作(${status})⇒ 清锁会放第二次部署去撞它`
            : `${name}:栈处于非稳定终态(${status})—— CFN 明确未成功回滚/未稳定,清锁不安全`
        );
      }
      if (pendingChangeSets > 0) {
        blockers.push(`${name}:存在 ${pendingChangeSets} 个未执行 change set ⇒ 基础设施随时可能被改动`);
      }
    })
  );

  stacks.sort((a, b) => a.name.localeCompare(b.name));
  blockers.sort();
  return { checkedAt: new Date().toISOString(), stacks, stable: blockers.length === 0, blockers };
}

/**
 * 🔴 P0-E:从**构建日志**里取那一行机器可读裁决(`P0E_IMPACT_VERDICT {json}`)。
 *
 * 【为什么走日志而不是让 build 回写数据库】buildspec **不许**写注册表(synth-gate 有负向断言钉死:
 *   出现 `update-item` 即红 —— 半份描述符写进注册表比不写更糟,§20.11-N2 的教训)。而 CodeBuild 里
 *   算出来的裁决必须传回平台 ⇒ 用日志做**单向**通道:build 只打印,平台只读。
 *
 * 🔴 这里返回的是"**上游声称**的裁决",平台**只用它来呈现与填 `operation.disruptive`**,
 *    绝不用它替代 build 侧的闸 —— 那一关在 CodeBuild 里**重算**,不信任何递进来的结论(纵深防御)。
 * 🔴 拿不到 ⇒ 返回 `null`,调用方按 fail-closed 处理(`disruptive` 保持 true),**绝不猜成"无影响"**。
 */
export interface ImpactVerdict {
  target: string;
  planHash: string;
  disruptive: boolean;
  requiresApproval: boolean;
  changeCount: number;
  stackCount: number;
  baseline?: { state: string; disruptive: boolean; requiresApproval: boolean; why: string };
  sourceRef?: string;
  baselineRef?: string;
  reasons: Array<{
    stackName: string;
    logicalResourceId: string;
    resourceType: string;
    action: string;
    replacement?: string;
    why: string;
    stateful: boolean;
    requiresApproval: boolean;
  }>;
}

/** 与 `infra/scripts/deploy-impact.mjs` 的 `IMPACT_MARKER` 逐字一致(两侧同一个字面量,漂移会让取值静默失败)。 */
export const IMPACT_MARKER = "P0E_IMPACT_VERDICT";

export async function fetchImpactVerdict(buildId: string): Promise<ImpactVerdict | null> {
  const parsed = (await fetchBuildMarkerJson(buildId, IMPACT_MARKER)) as ImpactVerdict | null;
  if (!parsed) return null;
  // 形状 fail-closed:关键字段缺失/类型不对 ⇒ 当作没拿到(绝不半信半疑地用)
  if (
    typeof parsed?.planHash !== "string" ||
    typeof parsed?.disruptive !== "boolean" ||
    typeof parsed?.requiresApproval !== "boolean" ||
    !Array.isArray(parsed?.reasons)
  ) {
    return null;
  }
  return parsed;
}

/**
 * 构建日志里**最后一条** `<marker> {json}` 行 → 解析出的对象(单向日志通道的唯一读法:P0-E 裁决与销毁报告共用)。
 * 拿不到 / 不是 JSON / 读日志失败 ⇒ `null`(调用方按 fail-closed 处理,绝不猜)。
 */
async function fetchBuildMarkerJson(buildId: string, marker: string): Promise<unknown | null> {
  const build = await fetchBuild(buildId);
  const groupName = build?.logs?.groupName;
  const streamName = build?.logs?.streamName;
  if (!groupName || !streamName) return null;
  try {
    const logs = sdkClient("control-plane", CloudWatchLogsClient, { region: HOME_REGION });
    // 🔴 标记行在长输出之后打印(`cdk deploy --no-execute` / 销毁的逐步日志)⇒ 取尾部足量行(不是 20 行)。
    const out = await logs.send(
      new GetLogEventsCommand({ logGroupName: groupName, logStreamName: streamName, limit: 2000, startFromHead: false })
    );
    const events = out.events ?? [];
    // 从后往前找**最后一条**(同一 build 只会打一次;从后往前是为了万一重试也取最新)
    for (let i = events.length - 1; i >= 0; i--) {
      const line = events[i]?.message ?? "";
      const at = line.indexOf(marker);
      if (at < 0) continue;
      try {
        return JSON.parse(line.slice(at + marker.length).trim());
      } catch {
        return null;
      }
    }
    return null;
  } catch (e) {
    console.error("[exec-env/deploy-control] 取构建日志标记 %s 失败:%s", marker, sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)));
    return null;
  }
}

// @kf-batch 50-WP30-decommission
/** 与 `infra/scripts/exec-env-destroy.sh` 打印的标记逐字一致(两侧同一个字面量;漂移会让取值静默失败 —— 单测读脚本源码钉住)。 */
export const DESTROY_REPORT_MARKER = "EXEC_ENV_DESTROY_REPORT";

/** 销毁脚本的机器可读报告(build 只打印、平台只读;平台**另外**自己真查 AWS,报告只用来点名「卡在哪」)。 */
export interface DestroyReport {
  target: string;
  region: string;
  finalSnapshot: string;
  ok: boolean;
  exitCode: number;
  steps: Array<{ step: string; status: string; resource: string; detail: string }>;
  stuck?: { step: string; status: string; resource: string; detail: string };
}

export async function fetchDestroyReport(buildId: string): Promise<DestroyReport | null> {
  const r = (await fetchBuildMarkerJson(buildId, DESTROY_REPORT_MARKER)) as DestroyReport | null;
  if (!r || typeof r.ok !== "boolean" || !Array.isArray(r.steps)) return null;
  return r;
}

/**
 * 触发下线销毁(WP-30 路 B):invoke broker `{targetId, operationId, mode:"destroy"}` —— **不传组件、不传快照名**
 * (broker 只从注册表的删除计划读;多传一个字段它就拒)。失败形态与 `invokeDeployBroker` 同一套。
 */
export async function invokeDestroyBroker(targetId: string, operationId: string): Promise<BrokerResult> {
  let out;
  try {
    out = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: EXEC_ENV_BROKER_NAME,
        Payload: Buffer.from(JSON.stringify({ targetId, operationId, mode: "destroy" })),
      })
    );
  } catch (e) {
    throw describeBrokerInvokeFailure(e);
  }
  if (out.FunctionError) {
    throw new Error(`broker 执行异常(FunctionError=${out.FunctionError})—— broker 本身故障,非业务拒绝`);
  }
  const raw = out.Payload ? Buffer.from(out.Payload).toString("utf8") : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`broker 响应不是 JSON(前 200 字:${raw.slice(0, 200)})`);
  }
  const r = parsed as Partial<BrokerResult> & { ok?: unknown };
  if (typeof r?.ok !== "boolean") throw new Error(`broker 响应缺 ok 字段 —— broker 契约漂移(收到:${raw.slice(0, 200)})`);
  if (r.ok === true && (typeof r.buildId !== "string" || r.buildId.length === 0)) throw new Error("broker 报成功但没给 buildId —— broker 契约漂移");
  return parsed as BrokerResult;
}

/** 构建日志尾部 20 行。任何失败降级 ""(理由同上:日志是辅助信息,不该拖垮进度接口)。 */
async function fetchLogsTail(build: BuildLite): Promise<string> {
  const groupName = build.logs?.groupName;
  const streamName = build.logs?.streamName;
  if (!groupName || !streamName) return "";
  try {
    const logs = sdkClient("control-plane", CloudWatchLogsClient, { region: HOME_REGION });
    const out = await logs.send(
      new GetLogEventsCommand({ logGroupName: groupName, logStreamName: streamName, limit: 20, startFromHead: false })
    );
    return (out.events ?? [])
      .map((e) => (e.message ?? "").trimEnd())
      .filter((l) => l.length > 0)
      .join("\n");
  } catch (e) {
    console.error("[exec-env/deploy-control] 拉构建日志失败,logsTail 降级为空:%s", String((e as Error)?.message ?? e));
    return "";
  }
}
