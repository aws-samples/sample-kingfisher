// 执行角色**保存 / 启动前预检**的统一入口(四个作业入口 + 两条保存路由 + 页面「检查权限」都走这里)。
//
// 它只是 `lib/role-advisor/preflight.ts#preflightRole` 的落点化封装:按引擎解析落点(区 / 脚本桶 / 日志桶),把作业**实际引用面**
// (--extra-jars / --extra-py-files / 脚本里的 s3:// 字面)作为额外探针带进去,并要求信任策略含该引擎服务主体。
// 三态语义不变:齐 ⇒ 放行;缺 ⇒ 400 当场拒(message 逐条列「动作 → 资源 → 为什么要」+ 出路);量不了 ⇒ 不阻断但回显。
// 🔴 只量**自定义**角色:平台默认角色由 CDK 建、权限本来就齐(调用方用 `resolveExecutionRoleArn().isCustom` 判)。
// 【数据湖表桶路由(设计稿 §6.6)】多一组**按表桶量**的探针:调用方把作业被选中的数据湖路由(`SelectedRoute[]`,带 read / write)
//   传进来,这里经唯一作者 `lakeRouteProbes` 派生 s3tables(+ Glue 引擎的联邦目录)探针并进 `preflightRole`。
//   角色缺某个桶的权限 ⇒ 保存 400 点名动作与桶 ARN(原来要跑到第一次访问表才 403)。

import { apiError } from "@/lib/api-response";
import { resolveEmrBinding, resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { resolveFlinkPlace } from "@/lib/realtime/flink-place";
import { preflightRole, type PreflightResult } from "@/lib/role-advisor/preflight";
import { lakeRouteProbes } from "@/lib/role-advisor/lake-probes";
import type { SelectedRoute } from "@/lib/lake/routes";
import { s3UrisFromScript } from "./s3-uris";
import { SERVICE_PRINCIPAL_BY_ENGINE, type ExecRoleEngine } from "./types";

export type { PreflightResult } from "@/lib/role-advisor/preflight";

export interface ExecRolePreflightInput {
  engine: ExecRoleEngine;
  roleArn: string;
  /** 落点(多区作业逐区量;预检模拟带 aws:RequestedRegion = 该区)。 */
  targetId: string;
  /** 作业引用的 S3 URI(Glue 两组依赖字段;Flink 无)。 */
  extraS3Uris?: string[];
  /** 脚本正文(里面的 s3:// 字面也量)。 */
  scriptCode?: string;
  /** 数据湖表桶路由:作业被选中的数据湖路由(读集必量;write 再量写集;Glue 引擎另量联邦目录)。缺省 / 空 = 不量路由。 */
  lakeRoutes?: readonly SelectedRoute[];
}

interface Landing { region: string; scriptBucket?: string; logBucket?: string }

async function landingOf(engine: ExecRoleEngine, targetId: string): Promise<Landing> {
  if (engine === "glue") {
    const l = await resolveGlueBinding({ targetId });
    return { region: l.region, scriptBucket: l.scriptsBucket, logBucket: l.datalakeBucket };
  }
  if (engine === "emr") {
    const l = await resolveEmrBinding({ targetId });
    return { region: l.region, scriptBucket: l.scriptsBucket, logBucket: l.datalakeBucket };
  }
  const p = await resolveFlinkPlace(targetId);
  return { region: p.region, scriptBucket: p.codeBucket };
}

/** 按落点量一次(调用方已判定是自定义角色)。 */
export async function preflightExecutionRole(input: ExecRolePreflightInput): Promise<PreflightResult> {
  const landing = await landingOf(input.engine, input.targetId);
  const extra: string[] = [];
  for (const u of [...(input.extraS3Uris ?? []), ...s3UrisFromScript(input.scriptCode)]) if (!extra.includes(u)) extra.push(u);
  const account = process.env.AWS_ACCOUNT_ID || "";
  return preflightRole({
    engine: input.engine,
    roleArn: input.roleArn,
    region: landing.region,
    accountId: account,
    logBucket: landing.logBucket,
    scriptBucket: landing.scriptBucket,
    requireTrustService: SERVICE_PRINCIPAL_BY_ENGINE[input.engine],
    extraS3Uris: extra,
    requestedRegion: landing.region,
    extraProbes: lakeRouteProbes(input.lakeRoutes ?? [], { engine: input.engine, account }),
  });
}

/** 预检未通过(缺 / 形态 / 不存在 / 不信任)⇒ 400 可修拒因;`detail` 给页面逐条渲染。 */
export class ExecRolePreflightError extends Error {
  readonly status = 400 as const;
  readonly code = "VALIDATION_FAILED" as const;
  constructor(readonly result: PreflightResult, readonly ctx: { engine: ExecRoleEngine; roleArn: string; targetId: string }) {
    super(result.message || "执行角色预检未通过");
    this.name = "ExecRolePreflightError";
  }
}

/** 不通过就抛;量不了只 warn(调用方自己决定要不要把 `unverifiable` 带给用户)。 */
export function assertPreflightPassed(result: PreflightResult, ctx: { engine: ExecRoleEngine; roleArn: string; targetId: string; what: string }): void {
  if (!result.ok) throw new ExecRolePreflightError(result, ctx);
  if (result.unverifiable) console.warn(`[exec-role:preflight] ${ctx.what} ${ctx.targetId} ${result.unverifiable}`);
}

export const EXEC_ROLE_PREFLIGHT_REASON = "exec-role-preflight" as const;

/** 路由侧:预检结果 ⇒ 400 响应(通过 ⇒ null)。 */
export function preflightErrorResponse(result: PreflightResult, ctx: { engine: ExecRoleEngine; roleArn: string; targetId: string }) {
  if (result.ok) return null;
  return apiError(result.message || "执行角色预检未通过", 400, {
    code: "VALIDATION_FAILED",
    detail: { reason: EXEC_ROLE_PREFLIGHT_REASON, ...ctx, roleExists: result.roleExists, gaps: result.gaps, checked: result.checked },
  });
}

/** 把抛出来的 `ExecRolePreflightError` 整形成同一形态的 400(服务层抛、路由层接)。 */
export function execRolePreflightErrorResponse(e: unknown) {
  if (!(e instanceof ExecRolePreflightError)) return null;
  return preflightErrorResponse(e.result, e.ctx);
}

/**
 * 保存路由用:自定义角色 ⇒ 对每个绑定落点量一遍,第一处不通过就回 400;全部通过 / 不是自定义 ⇒ null。
 * 🔴 保存那一刻就把「这个角色读不到你的桶」说出来(客户现网那条 403 就是等到 Glue 启动期才炸)。
 * 数据湖表桶路由:`lakeRoutesFor(targetId)` 由调用方给(作业声明按该区解析成被选中的路由),不给 = 不量路由。
 */
export async function preflightCustomRoleForTargets(args: {
  engine: ExecRoleEngine;
  customRoleArn: unknown;
  targets: string[];
  extraS3Uris?: string[];
  scriptCode?: string;
  lakeRoutesFor?: (targetId: string) => Promise<readonly SelectedRoute[]>;
}) {
  const roleArn = typeof args.customRoleArn === "string" ? args.customRoleArn.trim() : "";
  if (!roleArn) return null;
  for (const targetId of args.targets) {
    const lakeRoutes = args.lakeRoutesFor ? await args.lakeRoutesFor(targetId) : undefined;
    const result = await preflightExecutionRole({ engine: args.engine, roleArn, targetId, extraS3Uris: args.extraS3Uris, scriptCode: args.scriptCode, lakeRoutes });
    const res = preflightErrorResponse(result, { engine: args.engine, roleArn, targetId });
    if (res) return res;
  }
  return null;
}
