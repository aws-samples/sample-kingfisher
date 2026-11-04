// 作业**启动前**的执行角色权限预检。
//
// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴🔴 用户 2026-09-22 原话:
//   「**他需要知道这种任务需要添加哪些权限**,而不是报错了之后我通过你改源代码重新发布解决问题。」
//
// 【它替代了什么】原来的流程是:提交作业 → EMR 起步 → `AccessDenied: s3:PutObject .../job-metadata.log`
//   → 用户来找人 → 人去改 IAM/改源码。报错文本里**没有一个字**提示「缺日志落点写权限」。
// 【现在】提交之前就用 `SimulatePrincipalPolicy` 把必备权限逐条量一遍,缺了就**当场拒绝启动**并说清:
//   缺哪个 Sid、缺哪个动作、为什么需要它、以及出路(角色顾问一键补齐 / 把执行角色留空用平台默认角色)。
//
// 【🔴 三态,不是两态】(本仓铁律:段中断 / 少跑判据 / 判据有红必须三态分开)
//   · `ok`            量过了,齐 ⇒ 放行;
//   · `gaps` 非空      量过了,缺 ⇒ **拒绝启动**(这才是要拦的);
//   · `unverifiable`   **量不了**(平台自己没有 iam:SimulatePrincipalPolicy / 被限流)⇒
//                      **不阻断运行**,但如实回显「这次运行没有被预检过」。
//   🔴 为什么 `unverifiable` 不阻断:那会让「预检自己坏了」变成「整个平台跑不了作业」——
//     比原来的缺陷更坏。但它**绝不许静默当成通过**:调用方必须把这句话带给用户。
//
// 【扩展,2026-11-03】客户现网把 `--extra-py-files` 换到自己的桶 ⇒ 角色读不到 ⇒ Glue 启动期 403,
//   而预检只量引擎基线(日志组 / 脚本桶 / 数据湖桶),对作业**实际引用**的外部桶一个字不量 ⇒ 保存成功、运行才炸。三项追加:
//   · `requireTrustService`:GetRole 之后看信任策略 —— 自建角色不信任 glue.amazonaws.com 时当场指路(否则到 assume-role 才失败);
//   · `extraS3Uris`:每个作业引用的 S3 URI 追加 `s3:GetObject` 对象 + `s3:ListBucket` 桶两条探针(sid JobDependencyRead);
//   · `requestedRegion`:模拟带 `aws:RequestedRegion = 落点区`(客户角色若带区域条件也量得出来)。
//   统一入口在 `lib/execution-role/preflight.ts`(四入口 / 两条保存路由 / 页面「检查权限」都走它);本函数仍是唯一量法。
// ══════════════════════════════════════════════════════════════════════════════

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { IAMClient, GetRoleCommand, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { engineBaseline, type BaselineCtx } from "./engine-baseline";
import type { RoleEngine } from "./types";
import { ROLE_APPLY_HOW_TO } from "./labels";
// ARN 形态 / 角色名解析的唯一作者(此处原有一份同样的正则,已收口)
import { rolePathAndNameOfArn, roleNameOfArn } from "@/lib/execution-role/resolve";
import { parseS3Uri } from "@/lib/execution-role/s3-uris";
import { trustsService } from "@/lib/execution-role/trust";

const iam = sdkClient("control-plane", IAMClient, { region: homeRegion() });

export interface PreflightGap {
  sid: string;
  action: string;
  resource: string;
  why: string;
  decision: string; // implicitDeny / explicitDeny
}

export interface PreflightResult {
  /** true = 量过且齐,或**量不了**(见 unverifiable)。只有 `gaps` 非空才算不通过。 */
  ok: boolean;
  roleExists: boolean;
  gaps: PreflightGap[];
  /** 量了几条(0 且 ok=true ⇒ 一定有 unverifiable,不许当成「齐」)。 */
  checked: number;
  /** 🔴 量不了的原因 —— 调用方**必须**把它回显,不许当成通过。 */
  unverifiable?: string;
  /** 给用户的一段话(已包含出路)。调用方直接展示/抛出即可,不要自己另写一份。 */
  message?: string;
  /** 信任策略是否含要求的服务主体(没要求 ⇒ 不出现)。 */
  trusted?: boolean;
}

/** 作业依赖 / 脚本引用的 S3 URI ⇒ 两条探针(对象读 + 桶列),与引擎基线同形。 */
export const JOB_DEPENDENCY_SID = "JobDependencyRead";
const JOB_DEPENDENCY_WHY = "作业依赖库 / 脚本引用到的对象,引擎启动期用执行角色下载;读不到就是 LAUNCH ERROR 403(客户现网 2026-11-03 真撞)";

export function dependencyProbes(uris: string[]): { sid: string; action: string; resource: string; why: string }[] {
  const out: { sid: string; action: string; resource: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const raw of uris) {
    const p = parseS3Uri(raw);
    if (!p) continue;
    for (const probe of [
      { action: "s3:GetObject", resource: `arn:aws:s3:::${p.bucket}/${p.key}` },
      { action: "s3:ListBucket", resource: `arn:aws:s3:::${p.bucket}` },
    ]) {
      const k = `${probe.action}|${probe.resource}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ sid: JOB_DEPENDENCY_SID, why: JOB_DEPENDENCY_WHY, ...probe });
    }
  }
  return out;
}

export async function preflightRole(opts: {
  engine: RoleEngine;
  roleArn: string;
  region: string;
  accountId: string;
  logBucket?: string;
  scriptBucket?: string;
  /** 要求信任策略含这个服务主体(如 glue.amazonaws.com);不给 ⇒ 不核。 */
  requireTrustService?: string;
  /** 作业实际引用的 S3 URI(逐个追加对象读 + 桶列探针)。 */
  extraS3Uris?: string[];
  /** 模拟上下文 aws:RequestedRegion(落点区)。 */
  requestedRegion?: string;
}): Promise<PreflightResult> {
  const { engine, roleArn } = opts;
  const pathAndName = rolePathAndNameOfArn(roleArn);
  const roleName = roleNameOfArn(roleArn);
  if (!pathAndName || !roleName) {
    return {
      ok: false, roleExists: false, gaps: [], checked: 0,
      message: `执行角色 ARN 形态不对:${roleArn} —— 应形如 arn:aws:iam::<账号>:role/<角色名>。`,
    };
  }

  // ── ① 角色到底存在吗 ──────────────────────────────────────────────────────
  //   🔴 这一条是真实事故里第二个坑:作业规格写着 `bgp-job-role-emr1`,而账号里**压根没有这个角色**
  //     (copilot 编了一个名字)。不先查这一步,报错会变成一句离根因很远的 assume-role 失败。
  let assumeDoc: string | undefined;
  try {
    const got = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    assumeDoc = got.Role?.AssumeRolePolicyDocument;
  } catch (e) {
    const name = (e as { name?: string })?.name || "";
    if (name === "NoSuchEntityException" || name === "NoSuchEntity") {
      return {
        ok: false, roleExists: false, gaps: [], checked: 0,
        message: `执行角色 \`${roleName}\` 在本账号里**不存在**。`
          + `出路二选一:① 把作业规格里的「执行角色」**留空** ⇒ 用平台默认角色(权限本来就齐);`
          + `② ${ROLE_APPLY_HOW_TO} —— 它会建出平台受控角色并自动填回「执行角色」框。`,
      };
    }
    // 🔴 查不了 ≠ 不存在(「判不了」不许说成结论)
    return {
      ok: true, roleExists: true, gaps: [], checked: 0,
      unverifiable: `查角色是否存在时失败(${name || "未知错误"})⇒ 本次**没有**做权限预检`,
      message: `⚠️ 权限预检没能执行:查角色 ${roleName} 时失败(${name || "未知错误"})。作业照常提交,`
        + `但如果它报 AccessDenied,先看「角色顾问」里这个引擎的必备权限清单。`,
    };
  }

  // ── ①b:信任策略必须让该引擎的服务承担它(否则 PassRole 过了、服务起步 assume-role 就失败,报错离根因很远)──
  let trusted: boolean | undefined;
  if (opts.requireTrustService) {
    trusted = trustsService(assumeDoc, opts.requireTrustService);
    if (!trusted) {
      return {
        ok: false, roleExists: true, gaps: [], checked: 0, trusted,
        message: `作业**没有保存 / 提交**:执行角色 \`${roleName}\` 的信任策略不允许 ${opts.requireTrustService} 承担它,`
          + `该服务拿不到这个角色。出路:在 IAM 把这个角色的「信任实体」加上服务 ${opts.requireTrustService}`
          + `(Principal.Service),或把「执行角色」留空 ⇒ 用平台默认角色。`,
      };
    }
  }

  // ── ② 必备权限逐条量(按资源分组,少发几次请求)───────────────────────────
  const bctx: BaselineCtx = {
    region: opts.region, accountId: opts.accountId,
    logBucket: opts.logBucket, scriptBucket: opts.scriptBucket,
  };
  const needs = [
    ...engineBaseline(engine, bctx).map((n) => ({ sid: n.sid, why: n.why, action: n.probe.action, resource: n.probe.resource })),
    ...dependencyProbes(opts.extraS3Uris ?? []),
  ];
  type ResEntry = { actions: string[]; sids: Map<string, { sid: string; why: string }> };
  const byResource = new Map<string, ResEntry>();
  for (const n of needs) {
    const r = n.resource;
    const e: ResEntry = byResource.get(r) || { actions: [], sids: new Map() };
    if (!e.actions.includes(n.action)) e.actions.push(n.action);
    e.sids.set(n.action, { sid: n.sid, why: n.why });
    byResource.set(r, e);
  }
  const contextEntries = opts.requestedRegion
    ? [{ ContextKeyName: "aws:RequestedRegion", ContextKeyValues: [opts.requestedRegion], ContextKeyType: "string" as const }]
    : undefined;

  const gaps: PreflightGap[] = [];
  let checked = 0;
  for (const [resource, e] of Array.from(byResource.entries())) {
    try {
      const out = await iam.send(new SimulatePrincipalPolicyCommand({
        PolicySourceArn: roleArn,
        ActionNames: e.actions,
        ResourceArns: [resource],
        ...(contextEntries ? { ContextEntries: contextEntries } : {}),
      }));
      for (const r of out.EvaluationResults || []) {
        checked += 1;
        const dec = String(r.EvalDecision || "");
        if (dec === "allowed") continue;
        const meta = e.sids.get(String(r.EvalActionName || "")) || { sid: "?", why: "" };
        gaps.push({ sid: meta.sid, action: String(r.EvalActionName), resource, why: meta.why, decision: dec });
      }
    } catch (err) {
      // 🔴 量不了就**如实说**,不当成齐、也不当成缺。
      return {
        ok: true, roleExists: true, gaps: [], checked, trusted,
        unverifiable: `SimulatePrincipalPolicy 调用失败(${(err as { name?: string })?.name || "未知错误"})`
          + ` ⇒ 本次**没有**做权限预检`,
        message: `⚠️ 权限预检没能执行(平台可能缺 iam:SimulatePrincipalPolicy)。作业照常提交;`
          + `若报 AccessDenied,请${ROLE_APPLY_HOW_TO}。`,
      };
    }
  }

  if (gaps.length) {
    const lines = gaps.map((g) => `  · ${g.action} → ${g.resource}(${g.decision})\n    为什么需要它:${g.why}`);
    const depGaps = gaps.filter((g) => g.sid === JOB_DEPENDENCY_SID);
    const depHint = depGaps.length
      ? `\n③ 依赖库 / 脚本引用的桶读不到:给这个角色补上面列出的 s3:GetObject / s3:ListBucket,或把依赖库改走作业页面的「上传依赖文件」(落到平台脚本桶,平台默认角色能读)。`
      : "";
    return {
      ok: false, roleExists: true, gaps, checked, trusted,
      message: `作业**没有保存 / 提交**:执行角色 \`${roleName}\` 缺 ${gaps.length} 条必备权限 ——\n`
        + lines.join("\n")
        + `\n出路:① ${ROLE_APPLY_HOW_TO}(它会按必备权限清单对账写回这个角色);`
        + `② 把作业规格里的「执行角色」**留空** ⇒ 用平台默认角色。${depHint}\n`
        + `🔴 这些权限不是我猜的:它们来自平台的必备权限清单(引擎基线 + 作业实际引用的 S3 对象),`
        + `与作业真正会用到的落点是同一个真值源。`,
    };
  }
  return { ok: true, roleExists: true, gaps: [], checked, ...(trusted === undefined ? {} : { trusted }) };
}
