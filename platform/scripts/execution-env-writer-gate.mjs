#!/usr/bin/env node
/**
 * 🔴 **执行环境注册表的写点拓扑门禁**(外部审核 §24.3;P50.3b-2b 补齐 —— 此前仓内没有这道门)。
 *
 * 【为什么必须有它】P50.3b 的整个根治都建立在一句话上:"写 `observed`/`spec`/顶层投影/部署锁的地方
 *   **只有** `lifecycle.ts` 的少数几个函数"。在没有门禁之前,这句话只是**注释**——
 *   下一个人(或下一个我)在别处再加一个 `UpdateCommand`,1400+ 单测全绿、评审也看不见,
 *   而 bug#9/#11 那类"每长一条业务路径必漏一个前态"的病就原地复发。
 *   ⇒ 用 AST 把"哪个文件的哪个函数、允许发哪种 DDB 写命令"钉成白名单;多一个写点就红。
 *
 * 判据(全部基于 AST,不用 grep 目测 —— 见 ast-count-callsites.mjs 的同款教训):
 *   ① 在 `src/**`(排除 `__tests__`)里找**所有** `new <WriteCommand>(...)` 的 DDB 写命令;
 *   ② 只关心 `TableName` 解析得到**执行环境表**(`TABLES.EXECUTION_ENVS` / 字面量 `bgp-execution-envs`)的那些;
 *   ③ 每个这样的写点必须落在 `(文件, 最近的具名外层函数, 命令种类)` 白名单里;
 *   ④ 🔴 `TableName` **解析不出来**(动态表名 / 经参数传入)的写点一律**失败**(不许先放行后补白名单);
 *   ⑤ 白名单里**声明了却没出现**的条目也失败(防白名单腐烂:函数被删/改名后白名单还留着,
 *      下次有人复用同名函数就白拿一张通行证)。
 *
 * 用法:`node scripts/execution-env-writer-gate.mjs`(退出码非 0 即门禁红)。
 * 由 `src/lib/exec-env/__tests__/writer-topology.test.ts` 在 vitest 里真执行,进全量门禁。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = join(process.cwd(), "src");

/**
 * DDB 文档客户端的写命令(读命令 Get/Query/Scan/BatchGet 不在管辖范围)。
 * 🔴 刻意**不含** `ExecuteStatementCommand`:仓内该名字来自 `@aws-sdk/client-redshift-data`(Redshift Data API),
 *    不是 DynamoDB PartiQL —— 把它算进来会把二十来个与执行环境无关的 Redshift 调用当成"动态表名写点"误报。
 *    若将来真用 DDB PartiQL 写这张表,应在这里补上并同步白名单。
 */
const WRITE_COMMANDS = new Set([
  "UpdateCommand",
  "PutCommand",
  "DeleteCommand",
  "TransactWriteCommand",
  "BatchWriteCommand",
]);

/**
 * 🔴 **管辖范围 = 执行环境表的爆炸半径**:引用了 `TABLES.EXECUTION_ENVS` / 表名字面量的文件。
 * 只有这些文件里的"动态表名"才算 unknown 并失败 —— 其余模块各写各的表,
 * 全仓写点拓扑不是本批的范围(会牵动二十来个无关模块),如实划界而不是假装覆盖。
 */
function inExecEnvBlastRadius(src) {
  return src.includes("EXECUTION_ENVS") || src.includes("bgp-execution-envs");
}

/**
 * 🔴 白名单:`文件 → 函数 → 允许的命令种类`。
 * 每一条都要能用一句话说清"为什么这里可以写"—— 说不清就不该在这里写。
 */
const ALLOWLIST = {
  "lib/exec-env/lifecycle.ts": {
    // 唯一驱动 observed.phase / spec 的写通道(含完成态 fence 清锁)
    transitionPhase: ["UpdateCommand"],
    // 周期 telemetry 窄通道:只碰 health/probe/templateVersion,不涨 version,守 attribute_not_exists(operation)
    reconcileTelemetry: ["UpdateCommand"],
    // 🔴 P50.3b-2b:唯一的**失败路径**写入方(清 operation+锁 必须带已核验处置 + 管理员决定)
    recordOperationFailure: ["UpdateCommand"],
    // 🔴 P50.3b-4:`spec.intent` 的**唯一**写入方(排空 / 回服务)。为什么这里可以写:
    //   ① 只碰 `spec` + 物化投影(status/ready/components),**绝不碰 observed.phase**
    //      (phase 归 transitionPhase)⇒ 不构成第二个生命周期写入方;
    //   ② 条件写绑 version = :expected ∧ attribute_not_exists(observed.operation) ——
    //      后者挡住"部署途中改 intent 让完成栅栏永远合不上"这条机制互咬;
    //   ③ 值域只 serve/drain(delete 走 §4.6 销毁流程,不许只改标记造 tombstone 谎)。
    setSpecIntent: ["UpdateCommand"],
    //   ① 只写顶层 `networkProfile` + version(不碰 spec/observed/status/ready/components 投影 —— NAT 数只在下一次部署落栈,
    //      P0-E 把删 NAT 判成有状态变更要审批;这里改的是**期望**不是现实);
    //   ② 条件写绑 version = :expected ∧ attribute_not_exists(observed.operation) ∧ attribute_not_exists(deployLockOperationId)
    //      —— 部署途中改网络规模会让本次部署与期望不一致(与 setSpecIntent 同一机制互咬);
    //   ③ 值域只 standard / economy(isNetworkProfile 守,与 broker 映射表同源,synth-gate 钉字面)。
    // @kf-batch 50-WP15-airflow-serverless(施工序 6):setSchedulerPreference —— 顶层 schedulerPreference 的唯一写入方;
    //   只改「之后发布走哪个调度器」,不碰 spec/observed/投影;条件写与 setSpecIntent 同一机制互咬;值域 SSOT scheduler-preference.ts。
    setSchedulerPreference: ["UpdateCommand"],
    // @kf-batch 50-WP30-decommission —— 删除执行环境(路 B)的两个写点:
    //   markDecommissionApproved:审批通过 ⇒ `spec.intent = delete` + 顶层删除计划 `decommission`(同一次条件写)。
    //     为什么这里可以写:平台把 intent 置成 delete 的**唯一**入口;条件绑 version ∧ intent=drain ∧ phase 未变 ∧
    //     无 operation ∧ 无部署锁 ∧ attribute_not_exists(decommission);**不碰 observed.phase**(进销毁归 broker 的 destroy 开会话)。
    markDecommissionApproved: ["UpdateCommand"],
    //   settleDestroy:销毁会话收口 ⇒ `gone` / 留 `decommissioning` + lastError,清 destroy operation + 部署锁。
    //     为什么这里可以写:与 recordOperationFailure 同一纪律(锁只在带会话 fence 的条件写里清);gone 要求真查 AWS 零残留零看不清
    //     (函数入口校验,写不进假 gone);条件绑 version ∧ intent=delete ∧ phase=decommissioning ∧ destroy 会话 tuple ∧ 顶层锁。
    settleDestroy: ["UpdateCommand"],
  },
  "lib/exec-env/registry.ts": {
    registerTarget: ["PutCommand"], // 创建(attribute_not_exists(sk))
    seedHomeTarget: ["PutCommand"], // 创建(同上)
    reconcileTarget: ["UpdateCommand"], // 内容修补:RECONCILE_ALLOWED_FIELDS 白名单,不含 spec/observed/status/锁
    mergeComponentResources: ["UpdateCommand"], // 补充部署的窄通道:map-path 只增不改 + 必带 fence(bug#9 现场)
    // @kf-batch 50-WP15-airflow-serverless:home 组件**只增采纳**通道(SPEC v3.28 §1.1 / §2.1 seed-home)。为什么这里可以写:
    //   ① 只 home、只增(组件 + 组件私有资源键;既有键值不等即拒;摘组件即拒);② spec.desiredComponents / observed.components /
    //      components 三处同步(broker 的 observed ⊆ desired 与投影一致性);③ 本次真探全绿且覆盖全部组件才写(probe 一并落);
    //   ④ 条件写绑 version = :expected ∧ ready = true ∧ attribute_not_exists(observed.operation) ∧ attribute_not_exists(deployLockOperationId)。
    //   home 的组件由控制面栈建、不经 broker ⇒ 没有 finalize fence 可带,不能借 mergeComponentResources;reconcile 是维修态门(active 必拒)。
    adoptHomeComponents: ["UpdateCommand"],
    // @kf-batch 50-WP20-retire-classic-mwaa:retireComponents —— **摘掉一个已经不在现网的组件**。
    //   为什么必须新开一个写点(而不是塞进上面任何一个):`adoptHomeComponents` 明写「摘组件不是采纳」且要 status=active;
    //   `reconcileTarget` 是维修态门(要 ready=false);`mergeComponentResources` 是只增的窄通道。
    //   ⇒ 「组件在现网被真的删掉」这件事在改动前**没有任何合法出口**,唯一出路是手改 DDB(红线)。
    //   为什么这里可以写:① 不许摘 core;② 🔴 **探活还绿着的组件一律拒摘**(摘活组件 = 把它从平台视野里藏起来,
    //      比不摘危险得多)—— 路由侧强制**先真探**再摘,判据在 lib;③ 只丢「没有任何留下来的组件还要」的资源键
    //      (`resourceKeysFreedByRetiring`);④ spec.desiredComponents / observed.components / components 三处同步;
    //   ⑤ post-image 过 §3.1a 整包校验;⑥ 条件写绑 version = :expected ∧ attribute_not_exists(observed.operation)
    //      ∧ attribute_not_exists(deployLockOperationId);⑦ 路由侧输名强确认 + 审计。
    retireComponents: ["UpdateCommand"],
    writeProbeResult: ["UpdateCommand"], // 只写顶层 raw probe(stale gate 的时间源),不涨 version
    // 🔴 §3.9b 凭证隔离状态机(P0-3):**单调不可逆**、五字段专用通道、刻意没有逆向函数。
    //    与生命周期正交(不碰 spec/observed/phase/锁),故独立登记而不是塞进 reconcileTarget。
    advanceCredentialIsolationState: ["UpdateCommand"],
    // @kf-batch 50-WP9a-durable-jobs:§3.9b 的**延期**专用通道(provisioning → provisioning)。为什么这里可以写:
    //   ① 只碰 provisioningDeadlineAt / credentialEpoch / credentialStateUpdatedAt / provisioningOperationId / version;
    //   ② 条件写校验前态(必须仍是 provisioning)+ 当前 epoch,成功即 epoch++;③ 新 deadline 过 assertProvisioningDeadline(≤30 天,以现在为基准);
    //   ④ 不复用 advanceCredentialIsolationState —— 那个只认两条前进边,为延期放宽它 = 在单调状态机上开自环口子。
    extendProvisioningDeadline: ["UpdateCommand"],
    // 🔴 @kf-batch 50-W5-seg1-WP10a:项目白名单 `access` 的**唯一**写通道(SPEC v3.22 §1.1 / §2.1 POST .../access)。
    //    为什么这里可以写:① `access` 是**授权输入**,不属 resources(路由输入)也不属 spec/observed(生命周期)——
    //    reconcile 只服务维修态、窄通道只碰组件私有资源键,两条都不该为授权开口;② 条件写绑 version 乐观锁;
    //    ③ UpdateExpression 只有 access / version / updatedAt,身份 / 位置 / 状态 / 资源一个都不碰。
    setTargetAccess: ["UpdateCommand"],
    // 📌 刻意**不在**白名单里:reconcileAfterProbe / enableTarget / finalizeTargetResources ——
    //    它们不自己发写命令,而是构造 fence 后走 lifecycle.transitionPhase(这正是"单一写通道"要的形状)。
    //    若哪天它们开始自己发 UpdateCommand,本门禁会立刻红 —— 那就是单一写通道被绕开的信号。
  },
  "lib/exec-env/leader-lease.ts": {
    // 🔴 另一个分区(pk="lock"/sk="reconciler"),与描述符 item(pk="env")互不可见
    acquireOrRenewLeaderLease: ["UpdateCommand"],
    releaseLeaderLease: ["DeleteCommand"],
  },
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "__tests__" || e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** 最近的具名外层函数名(函数声明 / 变量赋值的箭头函数 / 方法)。取不到返回 null。 */
function enclosingFunctionName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && n.name && ts.isIdentifier(n.name)) return n.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    }
  }
  return null;
}

/**
 * 解析写命令的 `TableName`:返回 `"execution-env"` / `"other"` / `"unknown"`。
 * 只认两种确定形态:`TABLES.EXECUTION_ENVS`(属性访问)与 `"bgp-execution-envs"` 字面量;
 * 其余能解析成别的常量/字面量的算 `other`;**解析不出来的算 `unknown`(直接失败)**。
 */
function classifyTableName(callNode, sf) {
  let arg = callNode.arguments?.[0];
  // 跟随同文件内的 `const x = { TableName: ... }` 绑定(lifecycle.transitionPhase 就是这么写的)
  if (arg && ts.isIdentifier(arg)) {
    const name = arg.text;
    let found;
    const seek = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.initializer &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        found = n.initializer;
      }
      ts.forEachChild(n, seek);
    };
    seek(sf);
    if (found) arg = found;
  }
  if (!arg || !ts.isObjectLiteralExpression(arg)) return "unknown";
  const prop = arg.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "TableName"
  );
  if (!prop || !ts.isPropertyAssignment(prop)) return "unknown";
  const v = prop.initializer;
  if (ts.isStringLiteral(v)) return v.text === "bgp-execution-envs" ? "execution-env" : "other";
  if (ts.isPropertyAccessExpression(v)) {
    const text = v.getText();
    if (text === "TABLES.EXECUTION_ENVS") return "execution-env";
    if (/^TABLES\./.test(text)) return "other";
    return "unknown";
  }
  return "unknown";
}

const failures = [];
const seen = new Set(); // "file::fn::Command"

/**
 * 🔴 门禁自检钩子:`EXEC_ENV_WRITER_GATE_PROBE=<临时文件>` 会把该文件也纳入扫描。
 * 用途只有一个 —— 让 `writer-topology.test.ts` 能证明"塞一个未登记写点进来,门禁真的会红"。
 * 没有它,这道门禁自己是否有效就只能靠人肉相信(仓内已有多次"死门禁恒绿"的教训)。
 */
const probeFile = process.env.EXEC_ENV_WRITER_GATE_PROBE;
const files = [...walk(ROOT), ...(probeFile ? [probeFile] : [])];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!WRITE_COMMANDS.size) break;
  if (![...WRITE_COMMANDS].some((c) => src.includes(c))) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = relative(ROOT, file).replace(/\\/g, "/");

  const visit = (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && WRITE_COMMANDS.has(node.expression.text)) {
      const cmd = node.expression.text;
      const table = classifyTableName(node, sf);
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const fn = enclosingFunctionName(node);
      if (table === "unknown") {
        // 🔴 只在执行环境表的爆炸半径内失败(见 inExecEnvBlastRadius 的划界说明)
        if (inExecEnvBlastRadius(src)) {
          failures.push(
            `${rel}:${line} ${cmd} 的 TableName 解析不出来,而本文件引用了执行环境表 —— ` +
              "动态表名的写点一律拒(不许先放行后补白名单)"
          );
        }
      } else if (table === "execution-env") {
        if (!fn) {
          failures.push(`${rel}:${line} ${cmd} 不在具名函数里 —— 无法登记白名单,拒`);
        } else {
          const allowed = ALLOWLIST[rel]?.[fn];
          if (!allowed || !allowed.includes(cmd)) {
            failures.push(
              `${rel}:${line} ${cmd} 在 ${fn}() —— **未登记的执行环境表写点**。` +
                `P50.3b 的根治靠"写点只此几处",新增写点必须先在 execution-env-writer-gate.mjs 的白名单里` +
                `说明清楚为什么可以写(并配套 fence/条件写),否则 bug#9/#11 那类"漏一个前态"会原地复发`
            );
          }
          seen.add(`${rel}::${fn}::${cmd}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ⑤ 白名单腐烂:声明了却没出现的条目也失败
for (const [file, fns] of Object.entries(ALLOWLIST)) {
  for (const [fn, cmds] of Object.entries(fns)) {
    for (const cmd of cmds) {
      if (!seen.has(`${file}::${fn}::${cmd}`)) {
        failures.push(
          `白名单腐烂:${file} 的 ${fn}() 已不再发 ${cmd} —— 请从白名单删掉` +
            "(留着 = 下次有人复用同名函数就白拿一张通行证)"
        );
      }
    }
  }
}

if (failures.length) {
  console.error("🔴 执行环境写点拓扑门禁未通过:");
  for (const f of failures) console.error("  · " + f);
  process.exit(1);
}
console.log(`✅ 执行环境写点拓扑门禁通过:${seen.size} 个已登记写点,零未登记写点,零动态表名写点`);
