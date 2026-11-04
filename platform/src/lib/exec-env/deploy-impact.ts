// 🔴 P0-E:部署影响分类 —— **零依赖纯函数**,全仓判"这次部署会不会毁数据/要不要审批"的**唯一一份**判据。
//
// 【为什么必须是零依赖纯函数】① 判据要能被**穷举测**(change set 的 Action×Replacement×资源类型×Scope 组合有限,
//   全跑一遍比"读代码觉得对"可靠得多);② 它要被**两侧**用:平台侧(拒未审批的部署)与 build 侧(最后一关,
//   在 CodeBuild 里重算);两边各写一份必然漂移 —— 与 broker `planDeployOpen` 同一处境、同一解法。
//
// 【它解决的病(P0-E,DESIGN §12.6)】`add-components` 宣称"传全集、CDK 幂等只增不改",但这**只在源模板不变时成立**。
//   控制面 infra 一演进,给一个**在服务中**的 region 补个组件,就可能对已有 core 栈产生 changeset、
//   甚至 REPLACE 有状态资源(Redshift namespace / MWAA env / S3 桶 / KMS key)⇒ 停机或**直接丢数据**。
//   在此之前 `observed.operation.disruptive` 恒 `true`(fail-closed:部署期一律不承接新工作)——
//   本文件的作用是**让这个判断有真依据**,而不是把 fail-closed 换成乐观。
//
// 🔴 判据全文见 SPEC §3.5c ②。本文件不碰 AWS SDK、不读环境变量、不看时钟。

/** CloudFormation change set 里一条变更的**我们关心的部分**(字段名与 `DescribeChangeSet` 一致)。 */
export interface ChangeSetChange {
  /** `Add` | `Modify` | `Remove` | `Import` | `Dynamic`(未来新词一律按"看不清"处理)。 */
  action?: string;
  /** `True` | `False` | `Conditional`;`Add`/`Remove` 时 CFN 不给这个字段。 */
  replacement?: string;
  resourceType?: string;
  logicalResourceId?: string;
  /** CFN 的 `Scope`:`Properties` / `Tags` / `Metadata` / `CreationPolicy` / … */
  scope?: string[];
}

/** 一个栈的 change set 预演结果。`empty=true` 表示 CFN 明确回"没有变更"。 */
export interface StackChangeSet {
  stackName: string;
  /** CFN 明确"无变更"(`FAILED` + `didn't contain changes`,或 Changes 为空数组)。 */
  empty: boolean;
  changes: ChangeSetChange[];
  /**
   * 🔴 预演本身失败/拿不到(权限、栈不存在但也没建、change set 创建超时…)。
   * 看不清 ⇒ 后果最严:`disruptive=true ∧ requiresApproval=true`(绝不当成"没变更")。
   */
  unreadable?: string;
}

/**
 * 🔴 **有状态资源集** —— 替换或删除它们 = 停机或**丢数据**,故这类变更必须人来点头(SPEC §3.5c)。
 *
 * 判据是"这东西里面装着不可重建的东西吗":数据(Redshift namespace / S3 / DDB / RDS)、
 * 长期身份与密钥(KMS)、有状态托管环境(MWAA / MSK / DMS 实例)、元数据目录(Glue Database / Athena 历史)、
 * 以及一旦替换会牵连全部资源的网络底座(VPC / Subnet / NAT)。
 * 🔴 宁滥勿缺:多列一个只是多一次审批;漏列一个可能就是一次不可逆的数据丢失。
 */
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
] as const;

const STATEFUL = new Set<string>(STATEFUL_RESOURCE_TYPES);

/** CFN 的合法 `Action` 词表;出现表外的词一律按"看不清"处理(未来新词不许被当成 Add)。 */
const KNOWN_ACTIONS = new Set(["Add", "Modify", "Remove", "Import", "Dynamic"]);

/** `Scope` 里只碰这些 ⇒ 不算打断服务(改标签/元数据不影响在跑的作业)。 */
const HARMLESS_SCOPES = new Set(["Tags", "Metadata"]);

export interface ImpactReason {
  stackName: string;
  logicalResourceId: string;
  resourceType: string;
  action: string;
  replacement?: string;
  /** 为什么这条被判成 disruptive / 需审批(直接给人看,别让运维猜)。 */
  why: string;
  stateful: boolean;
  requiresApproval: boolean;
}

/**
 * 🔴 P0-E ④ 的三个输入(SPEC §3.5c ④ v3.6)。**没有一个来自客户端**:
 *   · `sourceRef` = 本次 build 实际用的源包身份,来自 CodeBuild **项目定义**(平台角色无 UpdateProject);
 *   · `baselineRef` = `observed.baselineRef`,上次**成功**部署所用的源;
 *   · `desiredTemplateVersion` = `spec.desiredTemplateVersion`,管理员**显式波次授权**。
 */
export interface BaselineRefs {
  sourceRef?: string;
  baselineRef?: string;
  desiredTemplateVersion?: string;
}

export type BaselineDriftState =
  | "unknown-source-no-baseline"
  | "unknown-source"
  | "no-baseline"
  | "no-drift"
  | "drift-authorized"
  | "drift-unauthorized";

export interface BaselineDrift {
  state: BaselineDriftState;
  disruptive: boolean;
  requiresApproval: boolean;
  why: string;
}

/**
 * 🔴 基线/波次判定(与 `infra/scripts/deploy-impact.mjs` 的 `classifyBaselineDrift` 同构,parity 门禁钉住)。
 *
 * 【为什么不是"重放旧源"】原合同写的重放机制**做不到也不许做**:CodeBuild 的 source 是按内容哈希不可变的
 *   CDK asset(源包排除 `.git`,build 里没有仓库),而唯一能换源的 `sourceLocationOverride` 已被
 *   §12.0 修法① 的 **IAM 显式 Deny** 禁掉(换源包 = 借 CodeBuild 的 `cloudformation:*`+`iam:PassRole`
 *   跑任意代码)。为防 P1 漂移去开那个口子 = 换来一个 P0 提权洞。⇒ 改成「漂移可见 + 显式波次」。
 *
 * 🔴 两个方向都要防,别只记住一个:
 *   · fail-open:源漂移了却不审批 ⇒ 补组件可能悄悄改到**在服务中**的栈;
 *   · **fail-closed 自锁**:全新 env 首装本来就没基线,若因此要求审批 ⇒ **首装被自己挡死**
 *     (初装 change set 全是 `Add`,本就无需审批)⇒ "缺基线"只提高 disruptive,**不**要求审批。
 */
export function classifyBaselineDrift(refs: BaselineRefs | undefined): BaselineDrift {
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

export interface DeployImpact {
  /** 是否打断服务 ⇒ 决定 `observed.operation.disruptive`(准入是否阻断)。 */
  disruptive: boolean;
  /** 是否必须管理员显式审批(触及有状态资源的替换/删除,或**看不清**)。 */
  requiresApproval: boolean;
  /** 🔴 审批绑定的计划指纹:计划变一个字节 ⇒ hash 变 ⇒ 旧审批自动失效。 */
  planHash: string;
  /** 逐条理由(升序稳定,便于页面呈现与审计留痕)。 */
  reasons: ImpactReason[];
  /** 统计口径(页面/审计用):变更总条数、涉及的栈数。 */
  changeCount: number;
  stackCount: number;
  /** 🔴 P0-E ④:基线/波次判定结果(页面呈现 + 审计;已并入上面的 disruptive/requiresApproval)。 */
  baseline: BaselineDrift;
}

/**
 * 计划指纹的 canonical 序列化:排序后逐条拼串(不含 why —— 文案变了不该让审批失效)。
 * 🔴 **含 sourceRef / baselineRef**:审批一份计划 = 审批"**从哪一份源**、相对**哪个基线**产生的这组变更";
 *    否则同一组变更文本在另一份源下可复用旧审批。头行不参与排序(排序只作用于变更行)。
 */
export function canonicalPlanText(stacks: StackChangeSet[], refs?: BaselineRefs): string {
  const head = `source:${refs?.sourceRef || "unknown"} baseline:${refs?.baselineRef || "none"}`;
  const rows: string[] = [];
  for (const s of stacks) {
    if (s.unreadable) {
      rows.push(`${s.stackName} UNREADABLE`);
      continue;
    }
    if (s.empty && s.changes.length === 0) {
      rows.push(`${s.stackName} EMPTY`);
      continue;
    }
    for (const c of s.changes) {
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

/**
 * 🔴 **唯一判据**(SPEC §3.5c ②)。取最严:任一条 disruptive ⇒ 整体 disruptive;任一条要审批 ⇒ 整体要审批。
 *
 * @param hash 计划指纹的哈希函数(平台侧传 node:crypto sha256;build 侧传 shell 里算好的同款)——
 *             本函数**刻意不 import crypto**,以保持零依赖、可在任何运行时穷举测。
 */
export function classifyDeployImpact(
  stacks: StackChangeSet[],
  hash: (text: string) => string,
  refs: BaselineRefs
): DeployImpact {
  const reasons: ImpactReason[] = [];
  let changeCount = 0;

  // 🔴 P0-E ④:基线/波次判定与 change-set 判定**并列取最严**。做成一个 reason 行(而不是让调用方
  //    自己去合并两个返回值)的理由:`disruptive`/`requiresApproval` 都由 reasons 聚合
  //    ⇒ 调用方**结构上不可能忘记**合并基线判定。`refs` 也刻意设为**必填**,不给默认值。
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
    // ① 看不清 ⇒ 后果最严(绝不当成"没变更")
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
    for (const c of s.changes) {
      changeCount++;
      const action = c.action ?? "";
      const resourceType = c.resourceType ?? "";
      const logicalResourceId = c.logicalResourceId ?? "?";
      const stateful = STATEFUL.has(resourceType);
      const base = { stackName: s.stackName, logicalResourceId, resourceType, action, replacement: c.replacement, stateful };

      // ① 未知 action / 缺资源类型 ⇒ 最严
      if (!KNOWN_ACTIONS.has(action) || resourceType.length === 0) {
        reasons.push({
          ...base,
          why: `无法判定的变更(action=${JSON.stringify(c.action)} resourceType=${JSON.stringify(c.resourceType)})—— 按最严处理`,
          requiresApproval: true,
        });
        continue;
      }

      // ② 删除
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

      // ③ 替换(True / Conditional 同等对待:Conditional = CFN 自己都说不准)
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

      // ④ 原地修改:只碰 Tags/Metadata 不算打断
      if (action === "Modify" || action === "Import" || action === "Dynamic") {
        const scopes = c.scope ?? [];
        const harmless = scopes.length > 0 && scopes.every((x) => HARMLESS_SCOPES.has(x));
        if (harmless) continue; // 不进 reasons = 不影响判定
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

      // ⑤ Add:这才是 add-components 承诺的"只增不改"
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

/** 人可读的一句话摘要(页面横幅 / 审批弹窗 / 审计 detail 用同一份文案)。 */
export function summarizeImpact(impact: DeployImpact): string {
  if (!impact.disruptive) {
    return `只增不改:${impact.stackCount} 个栈共 ${impact.changeCount} 条变更,无删除/替换/原地改属性 ⇒ 可边服务边部署`;
  }
  const approval = impact.reasons.filter((r) => r.requiresApproval);
  // 🔴 真环境实测暴露的**文案不准**:审批原因可能是**源漂移**(基线判定),此时说成
  //    "触及有状态资源的替换/删除"是错的 —— 会把运维引到错的方向去查。按真实原因分类叙述。
  const byBaseline = approval.filter((r) => r.stackName === "(baseline)").length;
  const byChange = approval.length - byBaseline;
  const parts: string[] = [];
  if (byChange > 0) parts.push(`${byChange} 条触及有状态资源的替换/删除或不可判定`);
  if (byBaseline > 0) parts.push("源已漂移且无显式波次授权");
  const head = approval.length > 0
    ? `需管理员审批(${parts.join(";")})`
    : `会打断服务(${impact.reasons.length} 条变更)`;
  return `${head};计划指纹 ${impact.planHash.slice(0, 12)}…`;
}
