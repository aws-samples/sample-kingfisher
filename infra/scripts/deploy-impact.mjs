// @kf-batch 50-P50.3b-3-p0e-baseline
// 🔴 P0-E 部署影响分类 —— **build 侧的那一份**(零依赖纯 ESM,给 buildspec 在 CodeBuild 里跑)。
//
// 【为什么会有两份】判据要同时服务两侧:
//   · 平台侧(`platform/src/lib/exec-env/deploy-impact.ts`):给页面呈现 + 填 `operation.disruptive` + 拦未审批的部署;
//   · build 侧(本文件):**最后一关** —— 部署强权只在 CodeBuild 服务角色上,真正能毁数据的那一步在这里,
//     所以它必须自己重算一遍,不能相信调用方递进来的结论(平台可能被绕过:有人直接 invoke broker)。
//   平台/infra 跨构建边界无法共享代码(平台镜像只 COPY platform/),与 broker `validate.mjs`、
//   `naming.json` 双侧出口是同一处境。⇒ 采同一解法:**两份实现 + 全交叉积 parity 门禁**
//   (`platform/src/lib/exec-env/__tests__/deploy-impact-parity.test.ts` 真 import 本文件逐格比对)。
//
// 🔴 改这里必须同步改 TS 那份,否则 parity 门禁立刻红(这正是它存在的意义)。判据全文见 SPEC §3.5c ②。

import { createHash } from "node:crypto";

/** 🔴 有状态资源集(替换/删除 = 停机或丢数据)。与 TS 侧逐字节一致,由 parity 门禁钉住。 */
export const STATEFUL_RESOURCE_TYPES = [
  "AWS::RedshiftServerless::Namespace",
  "AWS::RedshiftServerless::Workgroup",
  "AWS::Redshift::Cluster",
  "AWS::MWAA::Environment",
  "AWS::S3::Bucket",
  "AWS::S3Tables::TableBucket",
  "AWS::MSK::Cluster",
  "AWS::MSK::ServerlessCluster",
  "AWS::KMS::Key",
  "AWS::DMS::ReplicationInstance",
  "AWS::DMS::ReplicationSubnetGroup",
  "AWS::DynamoDB::Table",
  "AWS::DynamoDB::GlobalTable",
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBCluster",
  "AWS::Glue::Database",
  "AWS::Athena::WorkGroup",
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::NatGateway",
  "AWS::EFS::FileSystem",
  "AWS::OpenSearchService::Domain",
  "AWS::SecretsManager::Secret",
];

const STATEFUL = new Set(STATEFUL_RESOURCE_TYPES);
const KNOWN_ACTIONS = new Set(["Add", "Modify", "Remove", "Import", "Dynamic"]);
const HARMLESS_SCOPES = new Set(["Tags", "Metadata"]);

/**
 * 🔴 P0-E ④ 基线/波次判定(SPEC §3.5c ④ v3.6:**漂移可见 + 显式波次**,不重放旧源)。
 *
 * 三个输入都不是客户端能给的:`sourceRef` 来自 CodeBuild **项目定义**(平台角色无 UpdateProject),
 * 另两个由 broker 从**注册表描述符**读。判定与 change-set 判据**并列取最严**。
 *
 * 🔴 两个方向都要小心,别只记住一个:
 *   · fail-open 方向:源漂移了却不审批 ⇒ 补组件可能悄悄改到在服务的栈;
 *   · **fail-closed 自锁方向**:全新 env 首装本来就没有基线,若因此要求审批 ⇒ **首装被自己挡死**
 *     (初装 change set 全是 Add,本就无需审批)。所以"缺基线"只提高 disruptive,不要求审批。
 */
export function classifyBaselineDrift(refs) {
  const sourceRef = typeof refs?.sourceRef === "string" ? refs.sourceRef : "";
  const baselineRef = typeof refs?.baselineRef === "string" ? refs.baselineRef : "";
  const desired = typeof refs?.desiredTemplateVersion === "string" ? refs.desiredTemplateVersion : "";
  if (!sourceRef && !baselineRef) {
    return {
      state: "unknown-source-no-baseline",
      disruptive: true,
      requiresApproval: false,
      why: "看不到本次源身份、也没有基线(全新 env / 存量未记录)—— 按不承接新工作处理;但**不要求审批**,否则全新 env 首装被自己挡死",
    };
  }
  if (!sourceRef) {
    return {
      state: "unknown-source",
      disruptive: true,
      requiresApproval: true,
      why: "有基线却看不到本次源身份(项目级 EXEC_ENV_SOURCE_REF 缺失)—— 无法证明源没漂移,按最严处理",
    };
  }
  if (!baselineRef) {
    return {
      state: "no-baseline",
      disruptive: true,
      requiresApproval: false,
      why: "该 target 还没有成功部署过(无基线)—— 按不承接新工作处理;审批与否由 change set 决定",
    };
  }
  if (baselineRef === sourceRef) {
    return {
      state: "no-drift",
      disruptive: false,
      requiresApproval: false,
      why: "源零漂移(基线 === 本次源)—— 既有栈模板逐字节相同,CFN 天然 no-op,「只增不改」结构成立",
    };
  }
  if (desired && desired === sourceRef) {
    return {
      state: "drift-authorized",
      disruptive: false,
      requiresApproval: false,
      why: "源已漂移,但管理员已用 spec.desiredTemplateVersion 显式授权升到这一版(波次)—— 不因漂移加严;要替换有状态资源照样由 change set 判要审批",
    };
  }
  return {
    state: "drift-unauthorized",
    disruptive: true,
    requiresApproval: true,
    why: `源已漂移(基线 ${baselineRef.slice(0, 12)}… ≠ 本次源 ${sourceRef.slice(0, 12)}…)且无显式波次授权 —— 必须审批(审批的含义 = 我认这次漂移)`,
  };
}

/**
 * 计划指纹的 canonical 序列化(不含 why 文案 —— 改文案不该让已批准的计划失效)。
 * 🔴 **含 sourceRef / baselineRef**:审批一份计划 = 审批"**从哪一份源**、相对**哪个基线**产生的这组变更";
 *    否则同一组变更文本在另一份源下可复用旧审批。头行不参与排序(排序只作用于变更行)。
 */
export function canonicalPlanText(stacks, refs) {
  const head = `source:${refs?.sourceRef || "unknown"} baseline:${refs?.baselineRef || "none"}`;
  const rows = [];
  for (const s of stacks) {
    if (s.unreadable) {
      rows.push(`${s.stackName} UNREADABLE`);
      continue;
    }
    if (s.empty && (s.changes ?? []).length === 0) {
      rows.push(`${s.stackName} EMPTY`);
      continue;
    }
    for (const c of s.changes ?? []) {
      rows.push(
        [
          s.stackName,
          c.logicalResourceId ?? "?",
          c.action ?? "?",
          c.replacement ?? "-",
          c.resourceType ?? "?",
          [...(c.scope ?? [])].sort().join("+") || "-",
        ].join(" ")
      );
    }
  }
  rows.sort();
  return [head, ...rows].join("\n");
}

/** 🔴 唯一判据(取最严)。与 TS 侧同构;`hash` 可注入以便 parity 用同一函数比对。 */
export function classifyDeployImpact(stacks, hash = (t) => createHash("sha256").update(t).digest("hex"), refs) {
  const reasons = [];
  let changeCount = 0;

  // 🔴 P0-E ④:基线/波次判定与 change-set 判定**并列取最严**。做成一个 reason 行(而不是两个独立返回值)
  //    的理由:`disruptive`/`requiresApproval` 都由 reasons 聚合 ⇒ 调用方**不可能忘记合并**基线判定。
  const drift = classifyBaselineDrift(refs);
  if (drift.disruptive || drift.requiresApproval) {
    reasons.push({
      stackName: "(baseline)",
      logicalResourceId: "(source-ref)",
      resourceType: "(baseline)",
      action: drift.state,
      why: drift.why,
      stateful: false,
      requiresApproval: drift.requiresApproval,
    });
  }

  for (const s of stacks) {
    if (s.unreadable) {
      reasons.push({
        stackName: s.stackName,
        logicalResourceId: "(whole-stack)",
        resourceType: "(unknown)",
        action: "(unreadable)",
        why: `change set 预演不可读(${s.unreadable})—— 看不清就是不安全,按最严处理`,
        stateful: false,
        requiresApproval: true,
      });
      continue;
    }
    for (const c of s.changes ?? []) {
      changeCount++;
      const action = c.action ?? "";
      const resourceType = c.resourceType ?? "";
      const logicalResourceId = c.logicalResourceId ?? "?";
      const stateful = STATEFUL.has(resourceType);
      const base = { stackName: s.stackName, logicalResourceId, resourceType, action, replacement: c.replacement, stateful };

      if (!KNOWN_ACTIONS.has(action) || resourceType.length === 0) {
        reasons.push({
          ...base,
          why: `无法判定的变更(action=${JSON.stringify(c.action)} resourceType=${JSON.stringify(c.resourceType)})—— 按最严处理`,
          requiresApproval: true,
        });
        continue;
      }
      if (action === "Remove") {
        reasons.push({
          ...base,
          why: stateful
            ? "删除**有状态**资源 —— 会丢数据/停机,必须显式审批"
            : "删除资源 —— 会打断在跑的作业(不要求审批,但阻断准入)",
          requiresApproval: stateful,
        });
        continue;
      }
      if (c.replacement === "True" || c.replacement === "Conditional") {
        reasons.push({
          ...base,
          why: stateful
            ? `替换**有状态**资源(Replacement=${c.replacement})—— 会丢数据/停机,必须显式审批`
            : `替换资源(Replacement=${c.replacement})—— 会打断在跑的作业`,
          requiresApproval: stateful,
        });
        continue;
      }
      if (action === "Modify" || action === "Import" || action === "Dynamic") {
        const scopes = c.scope ?? [];
        const harmless = scopes.length > 0 && scopes.every((x) => HARMLESS_SCOPES.has(x));
        if (harmless) continue;
        reasons.push({
          ...base,
          why:
            scopes.length === 0
              ? `${action} 但 CFN 未给 Scope —— 看不清改了什么,按打断处理`
              : `${action} 原地改属性(Scope=${scopes.join("+")})—— 可能打断在跑的作业`,
          requiresApproval: false,
        });
        continue;
      }
      // Add ⇒ 只增不改,不进 reasons
    }
  }

  reasons.sort((a, b) =>
    `${a.stackName} ${a.logicalResourceId}`.localeCompare(`${b.stackName} ${b.logicalResourceId}`)
  );
  return {
    disruptive: reasons.length > 0,
    requiresApproval: reasons.some((r) => r.requiresApproval),
    planHash: hash(canonicalPlanText(stacks, refs)),
    baseline: drift,
    reasons,
    changeCount,
    stackCount: stacks.length,
  };
}

/**
 * 把 `aws cloudformation describe-change-set` 的原始 JSON 归一成本模块的输入形状。
 * 🔴 "没有变更"在 CFN 里表现为 change set `Status=FAILED` + `StatusReason` 含
 *    `didn't contain changes` / `No updates are to be performed` —— 那是**正常的空计划**,不是错误;
 *    任何**其它** FAILED 都必须落 `unreadable`(看不清 = 最严),绝不当成空。
 */
export function normalizeDescribeChangeSet(stackName, raw) {
  if (!raw || typeof raw !== "object") {
    return { stackName, empty: false, changes: [], unreadable: "describe-change-set 无输出" };
  }
  const status = String(raw.Status ?? "");
  const reason = String(raw.StatusReason ?? "");
  if (status === "FAILED") {
    if (/didn't contain changes|No updates are to be performed/i.test(reason)) {
      return { stackName, empty: true, changes: [] };
    }
    return { stackName, empty: false, changes: [], unreadable: `change set FAILED:${reason.slice(0, 160)}` };
  }
  if (status !== "CREATE_COMPLETE") {
    return { stackName, empty: false, changes: [], unreadable: `change set 状态 ${status || "(空)"} 非 CREATE_COMPLETE` };
  }
  const changes = (raw.Changes ?? []).map((ch) => {
    const rc = ch?.ResourceChange ?? {};
    return {
      action: rc.Action,
      replacement: rc.Replacement,
      resourceType: rc.ResourceType,
      logicalResourceId: rc.LogicalResourceId,
      scope: rc.Scope,
    };
  });
  return { stackName, empty: changes.length === 0, changes };
}

/** build 侧打印用的机器可读一行(平台从构建日志里取它 —— 见 SPEC §3.5c ③)。 */
export const IMPACT_MARKER = "P0E_IMPACT_VERDICT";
