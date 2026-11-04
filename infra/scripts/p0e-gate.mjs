#!/usr/bin/env node
/**
 * 🔴 P0-E 的**最后一关**(build 侧审批闸;SPEC §3.5c ①③)。
 *
 * 【为什么闸必须在 build 里】部署强权(CloudFormation / iam:PassRole / 建 Redshift·MWAA·桶)焊在 **CodeBuild 服务角色**上,
 *   真正能毁数据的那一步在这里执行。平台侧那道闸**可能被绕**(谁拿到平台角色就能直接 invoke broker),
 *   所以 build 必须**自己重算一遍**,绝不相信调用方递进来的结论。判据两侧同源由
 *   `platform/src/lib/exec-env/__tests__/deploy-impact-parity.test.ts` 的 840 格全交叉积钉住。
 *
 * 【做什么】
 *   ① 对该 target 的栈组做 **changeset 预演**(`cdk deploy --no-execute`:只创建不执行);
 *   ② 逐栈 `describe-change-set` → 归一 → 过唯一判据 → 算 `planHash`;
 *   ③ 打印一行带标记的机器可读裁决(平台从构建日志取它,给页面呈现 + 填 `operation.disruptive`);
 *   ④ 🔴 **清理干净**:删掉预演产生的 change set;`--no-execute` 对**尚不存在**的栈会留下
 *      `REVIEW_IN_PROGRESS` 空壳栈,也一并删除 —— 否则 2b 的恢复闸会因"存在未执行 change set /
 *      栈非稳定终态"永久拒绝恢复(两批互相咬,实测推演出来的坑);
 *   ⑤ 闸:计划**需审批**而 `EXEC_ENV_APPROVED_PLAN_HASH` 缺失/不匹配 ⇒ **build 失败**(退出码 1),绝不部署;
 *      另外若平台声明了 `EXEC_ENV_DECLARED_DISRUPTIVE` 而与本地重算不符 ⇒ 同样失败(逮住陈旧/说谎的上游)。
 *   ⑥ `EXEC_ENV_MODE=preview` ⇒ 只出裁决(供审批界面用),不进真部署(由 buildspec 判这个变量)。
 *
 * 🔴 任何一步"看不清"(describe 失败、change set 状态异常)都按最严处理 —— 判据里已内建,这里不许再兜回乐观。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { classifyDeployImpact, normalizeDescribeChangeSet, IMPACT_MARKER } from "./deploy-impact.mjs";
// @kf-batch 50-WP23-p0e-preview-flake —— 预演结果判定抽成纯函数(可离线真跑;理由见该文件头)
import { parseCdkStackFailures, classifyChangeSet, previewVerdict } from "./preview-outcome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 预演 change set 的固定名字(cdk 的 `--change-set-name`;平台与 build 两侧都按这个名字找)。 */
export const PREVIEW_CHANGE_SET_NAME = "bgp-p0e-preview";

const TARGET = req("EXEC_ENV_TARGET");
const REGION = req("EXEC_ENV_REGION");
// @kf-batch 50-PROD-B-seq33 ②:不再缺省成 core(精简形态的入口)—— broker 恒传完整组件集,缺即抛
const COMPONENTS = req("EXEC_ENV_COMPONENTS").split(",").map((s) => s.trim()).filter(Boolean);
const MODE = process.env.EXEC_ENV_MODE || "deploy";
const APPROVED = process.env.EXEC_ENV_APPROVED_PLAN_HASH || "";
const DECLARED = process.env.EXEC_ENV_DECLARED_DISRUPTIVE || "";
// @kf-batch 50-WP23-xregion-peering:broker 从描述符透传;home 可以为空
const VPC_CIDR = process.env.EXEC_ENV_VPC_CIDR || "";
// @kf-batch 50-WP23-xregion-peering:主控区那一侧的三件事实(buildspec 从 BgpVpcStack 的 Outputs 读出后 export);
//   与主控区同区 / home 时为空 —— 那时压根不建 peering。三个要么都有要么都没有(context.ts 那侧 fail-closed)。
const HOME_LINK = [
  ["exec-env-home-vpc-id", process.env.EXEC_ENV_HOME_VPC_ID || ""],
  ["exec-env-home-vpc-cidr", process.env.EXEC_ENV_HOME_VPC_CIDR || ""],
  ["exec-env-home-ddb-endpoint-id", process.env.EXEC_ENV_HOME_DDB_ENDPOINT_ID || ""],
].filter(([, v]) => v).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
const SLUG = TARGET.replace(/_/g, "-");

function req(name) {
  const v = process.env[name];
  if (!v) fail(`缺环境变量 ${name}(由 broker 的 environmentVariablesOverride 传入)`);
  return v;
}
function fail(msg) {
  console.error(`\n🔴 P0-E 闸拒绝:${msg}\n`);
  process.exit(1);
}
function aws(args, { allowFail = false } = {}) {
  try {
    return execFileSync("aws", [...args, "--region", REGION], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return "";
    throw e;
  }
}
const sha = (t) => createHash("sha256").update(t).digest("hex");

/** 该 target 的栈清单(命名 SSOT:base + 组件;与平台侧 `execEnvStackName` 同规则)。 */
function stackNames() {
  const naming = resolve(HERE, "../../platform/naming.json");
  if (!existsSync(naming)) fail(`找不到命名 SSOT ${naming}(源包不完整?)`);
  const n = JSON.parse(readFileSync(naming, "utf8"));
  // 🔴 kind 名是 `stackName`(不是 execEnvStack);平台侧 `execEnvStackName()` 走的也是它 ⇒ 单一真值源。
  const tpl = n.kinds?.stackName?.target;
  if (!tpl) fail("naming.json 缺 stackName kind —— 拒绝在 buildspec 里写第二处栈名字面量");
  const set = new Set(["base", "core", ...COMPONENTS]);
  return [...set].map((c) => tpl.split("{slug}").join(SLUG).split("{component}").join(c));
}

/** 栈当前状态;不存在返回 null。 */
function stackStatus(name) {
  const out = aws(
    ["cloudformation", "describe-stacks", "--stack-name", name, "--query", "Stacks[0].StackStatus", "--output", "text"],
    { allowFail: true }
  ).trim();
  return out && out !== "None" ? out : null;
}

function describeChangeSet(name) {
  const raw = aws(
    ["cloudformation", "describe-change-set", "--stack-name", name, "--change-set-name", PREVIEW_CHANGE_SET_NAME, "--output", "json"],
    { allowFail: true }
  );
  if (!raw.trim()) return normalizeDescribeChangeSet(name, null);
  try {
    return normalizeDescribeChangeSet(name, JSON.parse(raw));
  } catch (e) {
    return { stackName: name, empty: false, changes: [], unreadable: `describe-change-set 输出不是 JSON:${String(e).slice(0, 120)}` };
  }
}

/**
 * 🔴 清理:删 change set;`--no-execute` 给**尚不存在**的栈留下的 `REVIEW_IN_PROGRESS` 空壳栈也删掉。
 * 不清会让 2b 的恢复闸永久判"不稳定"(存在未执行 change set / 栈非稳定终态)⇒ 该 target 再也解不开锁。
 */
function cleanup(names, statusBefore) {
  const leftovers = [];
  for (const name of names) {
    // 🔴 2026-09-15 真环境:`CREATE_IN_PROGRESS` 的 changeset **删不掉**
    //    (`InvalidChangeSetStatus: Cannot delete ChangeSet in status CREATE_IN_PROGRESS`),
    //    而删不掉的未执行 changeset 会让 2b 的恢复闸永久判「不稳定」⇒ 该 target 再也解不开锁。
    //    ⇒ 删之前先把它等到终态(最多 ~2 分钟),删完再核一遍;还在就**响亮报出来**。
    waitChangeSetTerminal(name, { attempts: 24, delayMs: 5000 });
    aws(["cloudformation", "delete-change-set", "--stack-name", name, "--change-set-name", PREVIEW_CHANGE_SET_NAME], {
      allowFail: true,
    });
    if (changeSetClass(name) !== "missing") leftovers.push(name);
    const now = stackStatus(name);
    if (now === "REVIEW_IN_PROGRESS" && statusBefore[name] === null) {
      console.log(`p0e-gate: 删除预演留下的空壳栈 ${name}(REVIEW_IN_PROGRESS,预演前它不存在)`);
      aws(["cloudformation", "delete-stack", "--stack-name", name], { allowFail: true });
    }
  }
  if (leftovers.length) {
    console.log(
      `🔴 p0e-gate: 这些栈的预演 changeset **没删掉**:${leftovers.join(",")} —— ` +
        "未执行的 changeset 会让恢复闸判「不稳定」(该 target 解不开锁),请人工 delete-change-set。"
    );
  }
  return leftovers;
}

/** 读一个栈的预演 changeset 并归一成五态(missing/pending/ready/empty/failed)。 */
function changeSetClass(name) {
  const raw = aws(
    ["cloudformation", "describe-change-set", "--stack-name", name, "--change-set-name", PREVIEW_CHANGE_SET_NAME, "--output", "json"],
    { allowFail: true }
  );
  if (!raw.trim()) return "missing";
  try {
    return classifyChangeSet(JSON.parse(raw));
  } catch {
    return "failed";
  }
}

const sleepSec = (s) => {
  try {
    execFileSync("sleep", [String(s)], { stdio: "ignore" });
  } catch {
    /* sleep 不存在就算了(本地跑门禁) */
  }
};

/** 轮询到终态。`missing` 也要等(CFN 最终一致性窗口),但预算给得比 `pending` 小。 */
function waitChangeSetTerminal(name, { attempts = 24, delayMs = 5000, missingAttempts = 6 } = {}) {
  let cls = changeSetClass(name);
  let missSeen = 0;
  for (let i = 0; i < attempts && (cls === "pending" || cls === "missing"); i++) {
    if (cls === "missing" && ++missSeen > missingAttempts) break;
    sleepSec(Math.max(1, Math.round(delayMs / 1000)));
    cls = changeSetClass(name);
  }
  return cls;
}

/**
 * 🔴 P0-E ④ 的三个输入(SPEC §3.5c v3.6:漂移可见 + 显式波次,**不重放旧源** —— 重放机制
 * `sourceLocationOverride` 已被 §12.0 修法① 的 IAM Deny 禁掉,且源包里没有 `.git` 可 checkout)。
 * 判定在 `deploy-impact.mjs` 的 `classifyBaselineDrift`(与平台侧同源,parity 门禁钉住),
 * 并由 `classifyDeployImpact` 与 change-set 判定**并列取最严** ⇒ 这里只负责把入参递进去。
 */
function baselineRefs() {
  return {
    sourceRef: process.env.EXEC_ENV_SOURCE_REF || "",
    baselineRef: process.env.EXEC_ENV_BASELINE_REF || "",
    desiredTemplateVersion: process.env.EXEC_ENV_DESIRED_TEMPLATE_VERSION || "",
  };
}

// @kf-batch 50-WP13-mwaa-region —— CodeBuild 自带 AWS_REGION(项目建在控制面 region);本地跑门禁时缺省 us-east-1
const HOME_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";

function main() {
  const names = stackNames();
  const statusBefore = Object.fromEntries(names.map((n) => [n, stackStatus(n)]));
  console.log(`p0e-gate: target=${TARGET} region=${REGION} mode=${MODE} 栈=${names.join(",")}`);
  console.log(`p0e-gate: 预演前栈状态 ${JSON.stringify(statusBefore)}`);
  const refs = baselineRefs();
  console.log(`p0e-gate: 基线/波次入参 sourceRef=${refs.sourceRef || "(未注入)"} baselineRef=${refs.baselineRef || "(空)"} desiredTemplateVersion=${refs.desiredTemplateVersion || "(空)"}`);

  // ── ① 预演:只创建不执行 ──
  // 🔴🔴 2026-09-15 真环境事故(补装 dms 时):CDK 刚 `CreateChangeSet` 就去 describe,撞上 CloudFormation
  //    最终一致性窗口拿到 `ChangeSetNotFoundException` ⇒ 整条 deploy 判失败 ⇒ 闸按最严拒 ⇒
  //    **补装组件随机整体失败**,而那个 changeset 其实正在创建(紧接着的 delete 报
  //    `Cannot delete ChangeSet in status CREATE_IN_PROGRESS` 就是铁证)。
  //    ⇒ 不把 CDK CLI 的退出码当唯一真相:报错就**逐栈把 changeset 轮询到终态**,拿 CloudFormation
  //    自己的事实裁决(判定逻辑在 `preview-outcome.mjs`,纯函数 + 离线门禁)。fail-closed 不变:
  //    只要有一个栈读不到 / 仍在途 / 真失败 ⇒ 拒;错因全是瞬态且没有真失败时,清干净后**重试一次**。
  const previewArgv = () => [
        "cdk", "deploy", `BgpExecEnv-${SLUG}-*`,
        "--no-execute",
        "--change-set-name", PREVIEW_CHANGE_SET_NAME,
        "--require-approval", "never",
        "-c", `exec-env-target=${TARGET}`,
        "-c", `exec-env-region=${REGION}`,
        "-c", `exec-env-account=${req("EXEC_ENV_ACCOUNT")}`,
        "-c", `exec-env-components=${COMPONENTS.join(",")}`,
        // @kf-batch 50-WP4sexies-home-region —— 🔴 AZ 入参必须与 buildspec 的 cdk deploy **逐字一致**:
        //   base 栈的私有子网就是按它建的,两侧不同 ⇒ synth 出的子网不同 ⇒ 计划指纹必失配
        //   (与上面 K-5 的 NAT 数注释同一个道理)。值由 pre_build 的第二层 AZ preflight 选定并落文件,
        //   buildspec 在跑本脚本前 export EXEC_ENV_AZS;读不到就**停**,绝不各自默认。
        "-c", `exec-env-azs=${req("EXEC_ENV_AZS")}`,
        // @kf-batch 50-WP15-airflow-serverless(K-5):与 buildspec 的 cdk deploy 同一口径,否则预演与部署 synth 出的 base 栈 NAT 数不同 ⇒ 计划指纹必失配
        // @kf-batch 50-WP13-mwaa-region:控制面 region = 本 build 所在 region(与 buildspec 的 cdk deploy 同一口径;mwaa 组件回写 home 台账要它)
        ...(HOME_REGION ? ["-c", `exec-env-home-region=${HOME_REGION}`] : []),
        // @kf-batch 50-WP23-xregion-peering —— 🔴 VPC 地址段同样必须与 buildspec 的 cdk deploy **逐字一致**:
        //   它决定 VPC 与所有子网的 CidrBlock,两侧不同 ⇒ 预演与真部署 synth 出的 base 栈不同 ⇒ 计划指纹必失配。
        //   空值只在 home 合法(栈组对 home 沿用存量段);非 home 空值会在 synth 当场抛。
        ...(VPC_CIDR ? ["-c", `exec-env-vpc-cidr=${VPC_CIDR}`] : []),
        ...HOME_LINK,
      ];
  const MAX_PREVIEW_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_PREVIEW_ATTEMPTS; attempt++) {
    let cdkFailed = false;
    let output = "";
    try {
      // 🔴 必须**捕获**输出(原来是 stdio:"inherit"):失败时要按 CDK 自己的逐栈失败行判「瞬态还是真错」。
      //    捕获后照样整段打出来,build 日志一个字不少。
      output = execFileSync("npx", previewArgv(), {
        cwd: resolve(HERE, ".."),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      cdkFailed = true;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e);
    }
    console.log(output);
    if (!cdkFailed) break;

    const failures = parseCdkStackFailures(output);
    const outcomes = Object.fromEntries(names.map((n) => [n, waitChangeSetTerminal(n)]));
    const verdict = previewVerdict({ cdkFailed, failures, outcomes });
    console.log(`p0e-gate: 预演第 ${attempt}/${MAX_PREVIEW_ATTEMPTS} 次 —— CDK 报错;逐栈 changeset 终态 ${JSON.stringify(outcomes)}`);
    console.log(`p0e-gate: 裁决 proceed=${verdict.proceed} retry=${verdict.retry} — ${verdict.why}`);
    if (verdict.proceed) break;
    if (verdict.retry && attempt < MAX_PREVIEW_ATTEMPTS) {
      cleanup(names, statusBefore);   // 清干净再重试(同名 changeset 还在会撞 AlreadyExists)
      continue;
    }
    cleanup(names, statusBefore);
    fail(`changeset 预演失败:${verdict.why}`);
  }

  // ── ② 读 + 分类 ──
  const stacks = names.map(describeChangeSet);
  const impact = classifyDeployImpact(stacks, sha, refs);

  // ── ③ 机器可读裁决(平台从构建日志取这一行)──
  console.log(
    `${IMPACT_MARKER} ${JSON.stringify({
      target: TARGET,
      planHash: impact.planHash,
      disruptive: impact.disruptive,
      requiresApproval: impact.requiresApproval,
      changeCount: impact.changeCount,
      stackCount: impact.stackCount,
      baseline: impact.baseline,
      sourceRef: refs.sourceRef,
      baselineRef: refs.baselineRef,
      reasons: impact.reasons,
    })}`
  );
  console.log(`p0e-gate: 裁决 disruptive=${impact.disruptive} requiresApproval=${impact.requiresApproval} planHash=${impact.planHash}`);
  console.log(`p0e-gate: 基线判定 ${impact.baseline.state} — ${impact.baseline.why}`);
  for (const r of impact.reasons) console.log(`   · ${r.stackName}/${r.logicalResourceId}(${r.resourceType}) ${r.action} — ${r.why}`);

  // ── ④ 清理(无论闸放不放行都要清)──
  cleanup(names, statusBefore);

  // ── ⑤ 闸 ──
  if (DECLARED && DECLARED !== String(impact.disruptive)) {
    fail(
      `上游声明 disruptive=${DECLARED},本地重算=${impact.disruptive} —— 声明与事实不符(上游陈旧或被绕),拒绝部署`
    );
  }
  if (impact.requiresApproval) {
    if (!APPROVED) {
      fail(
        `本次计划触及有状态资源的替换/删除(或存在不可判定的变更),必须先审批:\n` +
          `   planHash = ${impact.planHash}\n` +
          `   审批后带 EXEC_ENV_APPROVED_PLAN_HASH=${impact.planHash} 重新发起部署(计划一变该值即失效)`
      );
    }
    if (APPROVED !== impact.planHash) {
      fail(
        `审批的计划与本次计划不是同一份(审批 ${APPROVED.slice(0, 16)}… ≠ 实际 ${impact.planHash.slice(0, 16)}…)—— 拒绝部署`
      );
    }
    console.log("p0e-gate: ✅ 需审批且 planHash 与审批一致 ⇒ 放行");
  } else {
    console.log("p0e-gate: ✅ 无需审批(无有状态资源的替换/删除,也无不可判定变更)");
  }

  if (MODE === "preview") {
    console.log("p0e-gate: mode=preview ⇒ 只出裁决,不执行部署");
  }
}

main();
