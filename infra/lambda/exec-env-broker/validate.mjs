// @kf-batch 50-P50.2c-control-api
// 执行环境部署 broker 的**纯校验逻辑**(零依赖、零 AWS SDK —— 这是它存在的全部理由)。
//
// 【为什么拆出来】ACCEPTANCE E-49 要求 broker 的入参 fail-closed 有**无头断言**,而 broker 是
// Lambda:handler 依赖 @aws-sdk/*(由 Lambda 运行时提供,本地 node_modules 没有),没法直接
// import 进测试。⇒ 把"不碰 AWS 的判定"全部收到本文件:synth-gate 用 node **原生 import** 真执行
// 用例矩阵(secs 级、零凭证),index.mjs 只做"取数 → 调这里判定 → 发 AWS 调用"的接线。
// 🔴 本文件**只允许 Node 内置 import**(`node:crypto`,v2 审核 §18.2 明确许可)—— 仍可被 E-49/synth-gate
//    原生 import 真执行;**绝不** import AWS SDK / 项目运行时依赖(加一个就把无头断言弄死)。
//
// 判定语义与切片 b 的 index.mjs **逐字节相同**(错误消息原文搬运,不许顺手改词 ——
// 消息是对外契约的一部分,平台侧按它给用户解释拒因)。
import { createHash } from "node:crypto";

/** broker 的结构化拒绝(code 供平台侧映射 HTTP 状态)。 */
export class Rejected extends Error {
  constructor(msg, code = "rejected") {
    super(msg);
    this.code = code;
  }
}

// @kf-batch 50-WP15-airflow-serverless
// 🔴 组件全集**不再在这里手抄**:WP-15 真环境撞到「平台 / 栈组都认 airflow-serverless、broker 仍拒『未知组件』」——
//    同一概念第三处定义必然漂移(A1)。唯一真源 = infra/lib/exec-env/context.ts 的 EXEC_ENV_COMPONENTS,
//    由 deploy-stack.ts 在部署期 join(",") 注入 env EXEC_ENV_COMPONENT_ENUM;缺 / 畸形 ⇒ 模块加载即抛(fail-closed,
//    宁可 broker 整体不可用也不许拿一份陈旧名单放行 / 误拒)。synth-gate §7c 钉:本文件无字面名单 + deploy-stack 注入 + 模板值 == 枚举。
export function parseComponentEnum(raw) {
  const list = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || !list.includes("core") || new Set(list).size !== list.length) {
    throw new Error("EXEC_ENV_COMPONENT_ENUM 缺失 / 不含 core / 含重复 —— broker 的组件全集必须由 CDK 从 context.ts 注入(deploy-stack.ts),不接受手抄");
  }
  return list;
}
export const COMPONENTS = parseComponentEnum(process.env.EXEC_ENV_COMPONENT_ENUM);
/**
 * @kf-batch 50-PROD-B-seq33 ② —— 完整组件集(由 deploy-stack.ts 从 context.ts 的 EXEC_ENV_REQUIRED_BASE_COMPONENTS 注入)。
 * 🔴 不在加载期抛(不让与它无关的纯函数测试跟着挂),而在**用的那一刻** fail-closed:缺 env ⇒ 拒绝部署。
 */
export function requiredComponentsForItem(item) {
  const list = String(process.env.EXEC_ENV_REQUIRED_COMPONENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || !list.includes("core")) {
    throw new Rejected("EXEC_ENV_REQUIRED_COMPONENTS 缺失 / 不含 core —— 完整组件集必须由 CDK 从 context.ts 注入(deploy-stack.ts)", "bad-components");
  }
  const j = typeof item?.jurisdiction === "string" && item.jurisdiction.length > 0 ? item.jurisdiction : "home";
  if (j !== "home" && item?.targetId !== "tgt_home") list.push("residency-api");
  return list;
}
export const TARGET_ID_RE = /^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$/;
export const OPERATION_ID_RE = /^op_[a-z0-9]{8,32}$/;
/** 可以(重)部署的状态。`draining`/`decommissioning`/`deleted` 一律拒 —— 那是删除流程的地盘。 */
export const DEPLOYABLE_STATUS = new Set([
  "registered",
  "initializing",
  "testing",
  "active",
  "degraded",
  "failed",
  "upgrading",
]);

/** ① 入参白名单:字段多一个就拒。纯函数:合法 ⇒ 返回归一化请求;非法 ⇒ throw Rejected。 */
/**
 * build 模式:`deploy` = 真部署;`preview` = 只出 changeset 裁决不执行(P0-E);
 * @kf-batch 50-WP30-decommission —— `destroy` = 下线销毁(WP-30 路 B)。
 * 🔴 destroy 只认**注册表**里的删除计划(审批通过时由平台写入 `decommission` + `spec.intent=delete`):
 *    入参只有 targetId / operationId / mode 三个字段 —— 销毁哪些栈、最终快照叫什么,一律不从入参取
 *    (从入参取 = 让调用方指定「毁掉什么」)。
 */
export const BUILD_MODES = ["deploy", "preview", "destroy"];
/** planHash 形态(sha256 hex);审批绑的是**这一份计划**,不是"这个 target"。 */
export const PLAN_HASH_RE = /^[a-f0-9]{64}$/;

export function validateInput(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Rejected("入参必须是对象");
  // 🔴 P0-E(P50.3b-3)新增两个**可选**字段:`mode` 与 `approvedPlanHash`。
  //    仍是**白名单**:多一个字段就拒(这里正是 override 攻击面的入口,拒而不是忽略)。
  const allowed = ["targetId", "components", "operationId", "mode", "approvedPlanHash"];
  const extra = Object.keys(event).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    // 🔴 拒而不是忽略:忽略会让调用方以为 override 生效了,而这里正是 override 攻击面的入口。
    throw new Rejected(`入参含未允许字段:${extra.join(", ")}(只接 ${allowed.join(", ")})`);
  }
  const { targetId, components, operationId } = event;
  if (typeof targetId !== "string" || !TARGET_ID_RE.test(targetId)) throw new Rejected(`targetId 非法:${targetId}`);
  if (typeof operationId !== "string" || !OPERATION_ID_RE.test(operationId)) {
    throw new Rejected(`operationId 非法:${operationId}(须 op_ + 8..32 位小写字母数字)`);
  }
  // @kf-batch 50-WP30-decommission —— destroy 先分流:它**不接** components / approvedPlanHash
  //   (拒而不是忽略:带了说明调用方以为自己能指定销毁范围 —— 那正是要堵的口子)。
  if (event.mode === "destroy") {
    if (components !== undefined) {
      throw new Rejected("destroy 模式不接 components —— 销毁范围只从注册表读(由平台在审批通过时写入删除计划)");
    }
    if (event.approvedPlanHash !== undefined) {
      throw new Rejected("destroy 模式不接 approvedPlanHash —— 销毁的授权是删除审批单,不是变更计划指纹");
    }
    if (targetId === "tgt_home") throw new Rejected("主控区执行环境永不可删(destroy 拒 tgt_home)", "bad-status");
    return { targetId, operationId, mode: "destroy" };
  }
  if (!Array.isArray(components) || components.length === 0) throw new Rejected("components 必须是非空数组");
  const bad = components.filter((c) => !COMPONENTS.includes(c));
  if (bad.length > 0) throw new Rejected(`components 含未知组件:${bad.join(", ")}`);
  if (!components.includes("core")) throw new Rejected("components 必须含 core");
  // 归一:去重 + 按枚举顺序,保证同一勾选产生同一 build 入参
  const normalized = COMPONENTS.filter((c) => components.includes(c));

  // ── P0-E 可选字段:形态严格,缺省 = 今天的行为(fail-closed 不变)──
  const mode = event.mode === undefined ? "deploy" : event.mode;
  if (!BUILD_MODES.includes(mode)) {
    throw new Rejected(`mode 非法:${JSON.stringify(event.mode)}(只接 ${BUILD_MODES.join("/")})`);
  }
  let approvedPlanHash;
  if (event.approvedPlanHash !== undefined) {
    if (typeof event.approvedPlanHash !== "string" || !PLAN_HASH_RE.test(event.approvedPlanHash)) {
      throw new Rejected(`approvedPlanHash 非法(须 sha256 hex 64 位):${JSON.stringify(event.approvedPlanHash)}`);
    }
    // 🔴 preview 不会执行任何变更 ⇒ 带审批毫无意义,且会掩盖"审批被用在别处"的误用 ⇒ 直接拒。
    if (mode === "preview") throw new Rejected("preview 模式不接 approvedPlanHash(预演不执行变更,审批无对象)");
    approvedPlanHash = event.approvedPlanHash;
  }
  return {
    targetId,
    components: normalized,
    operationId,
    mode,
    ...(approvedPlanHash ? { approvedPlanHash } : {}),
  };
}

/**
 * ② 注册表 item 的可部署判定(region/account **只**从 item 读,不从入参取)。
 * 纯函数:item 为空 / 状态不可部署 / 缺 region·accountId ⇒ throw Rejected;合法 ⇒ 返回 item。
 */
/**
 * ②a **描述符校验层**(v2 审核 §18.2.1):只做存在性 + region/accountId 形态,**不因 lock/status 拒**。
 * broker deploy 路径用它(`readTargetForDeploy`),这样 post-open 的 locked item 仍能进 planDeployOpen /
 * 后续恢复分类;普通准入用下面的 `assessTarget`(叠加 status admission)。
 */
export function validateTargetDescriptor(item, targetId) {
  if (!item) throw new Rejected(`执行目标未注册:${targetId}(先 register 再 deploy)`, "not-registered");
  for (const k of ["region", "accountId"]) {
    if (typeof item[k] !== "string" || item[k].length === 0) {
      throw new Rejected(`注册表 item 缺 ${k} —— 不从入参兜底(那等于让调用方指定部署去哪)`, "bad-descriptor");
    }
  }
  return item;
}

/** ②b 普通准入 = 描述符校验 + legacy status admission(其它普通调用方用)。 */
export function assessTarget(item, targetId) {
  validateTargetDescriptor(item, targetId);
  if (!DEPLOYABLE_STATUS.has(String(item.status))) {
    throw new Rejected(`执行目标 ${targetId} 的 status=${item.status} 不允许部署`, "bad-status");
  }
  return item;
}

/**
 * ③ 部署锁冲突的翻译:DynamoDB 条件写失败 ⇒ `locked` 的 Rejected;其它错误 ⇒ null(调用方原样抛)。
 * 纯函数:只看 err.name,不碰 AWS。
 */
export function translateLockError(err, target) {
  if (err?.name !== "ConditionalCheckFailedException") return null;
  return new Rejected(
    `执行目标 ${target.targetId} 正在部署中(部署锁被 ${target.deployLockOperationId ?? "另一操作"} 持有)—— ` +
      `同 target 并发 deploy 会撞 CFN 的 "operation in progress"(§12.2 P0-C)`,
    "locked"
  );
}

/**
 * CodeBuild 的**终态**集合(非终态 = build 还在跑 ⇒ 锁是活的,绝不接管)。
 * 值域取自 CodeBuild 的 `buildStatus`(IN_PROGRESS / SUCCEEDED / FAILED / FAULT / TIMED_OUT / STOPPED)。
 */
export const TERMINAL_BUILD_STATUS = new Set(["SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"]);

export function isTerminalBuildStatus(status) {
  return TERMINAL_BUILD_STATUS.has(String(status));
}

/**
 * ⑤ **陈锁(死锁残留)候选判定**(P50.2g:build 一失败就把部署入口卡死 90min 的 lease,
 * 而"重试部署"恰恰是刚失败时最需要的动作)。
 *
 * 返回 `{ buildId, prevOperationId, prevEpoch }`(= 可以去核查这个 build 的终态)或 `null`(不可接管)。
 * 🔴 **三个必要条件,少一个就不接管**(宁可让人等 lease,也不冒"两个 cdk deploy 同时打一个 region"的险):
 *   ① 锁真的被人持着(`deployLockOperationId` 在);
 *   ② `lastOperationId === deployLockOperationId` —— 否则 `lastBuildId` 不是**当前持锁者**的 build,
 *      拿它的终态做判据等于看错人的体温(锁刚被抢走、markInitializing 还没写就是这个形态);
 *   ③ `lastBuildId` 是非空字符串,且 `lockEpoch` 是数 —— 接管的条件写要绑这两个观测值做 fencing。
 *
 * 🔴 **残余风险如实登记**:build 终态 **不等于** 目标 region 的 CFN 一定空闲(build 被 STOPPED/TIMED_OUT
 * 在 CFN 滚动中途时,CFN 仍在跑)。此时接管会让下一次 `cdk deploy` 撞上 CFN 自己的
 * "operation in progress" 而快速失败 —— **CFN 才是权威串行器**,锁只是把那个晦涩错误提前成干净拒绝。
 * 后果是浪费一次 build,不会双写(epoch fencing 已挡住旧 build 回写)。要彻底判准得读目标 region 的
 * CFN 栈状态,那需要给 broker 跨 region 的 CFN 只读权 + 在 broker 内复现 targetSlug 派生(= 命名 SSOT
 * 的第二处定义),归 P50.3 一并做。
 */
export function staleLockCandidate(item) {
  const holder = item?.deployLockOperationId;
  if (typeof holder !== "string" || holder.length === 0) return null;
  if (item?.lastOperationId !== holder) return null;
  const buildId = item?.lastBuildId;
  if (typeof buildId !== "string" || buildId.length === 0) return null;
  const prevEpoch = Number(item?.lockEpoch);
  if (!Number.isFinite(prevEpoch)) return null;
  return { buildId, prevOperationId: holder, prevEpoch };
}

// ══════════════════════════════════════════════════════════════════════════════
// planDeployOpen —— broker 唯一的一条生命周期命令(v2 审核拍板 C / §18.2)
//   零 AWS、零项目依赖(仅 node:crypto)。输入=已过 validateInput 的 req + 强读的注册表 item + 本次 epoch;
//   输出=开 deploy operation 的完整 spec/observed post-image + 兼容投影。index.mjs 只消费 plan、发 AWS。
// ══════════════════════════════════════════════════════════════════════════════

// @kf-batch 50-WP23-xregion-peering
/**
 * 非 home 的执行环境**必须**在描述符里带 `vpcCidr`(注册时从地址池分配)。
 *
 * 【为什么 broker 要拦】跨区私网通路(peering + 主控区同区端点 + PHZ)的前提是**两侧 CIDR 不重叠**;
 * 而 CDK 不给 `ipAddresses` 时的默认值恰好与主控区 VPC 逐位相同。缺这个字段的描述符 = WP-23 之前
 * 注册的存量环境,部署出来的形态是**栈全绿、台账回写静默超时** —— 正是最难查的那一类。
 * ⇒ 在**起 build 之前**响亮地拒,别让它建出一个注定回写不了的环境。
 *
 * 🔴 **只判有没有,不判格式** —— 格式的唯一作者是 `infra/lib/exec-env/vpc-cidr.ts`
 * (`cdk synth` 时 `parseExecEnvVpcCidr` fail-closed)。在这里抄第二份正则就是 A1 违规:
 * 组件全集当年正是这么漂移的(见本文件上方 WP-15 那段)。
 * 🔴 判据方向是 **fail-closed**:`isHome !== true` ⇒ 要求必须有(缺 isHome 标记的非 home 也照样要求)。
 */
export function vpcCidrRejection(target) {
  if (target?.isHome === true) return null; // home 的执行环境栈组沿用存量段(它不与自己 peering)
  const v = target?.vpcCidr;
  if (typeof v === "string" && v.trim().length > 0) return null;
  return (
    `执行环境 ${String(target?.targetId ?? "?")} 的描述符缺 vpcCidr —— 它是 WP-23 之前注册的:` +
    `VPC 会用 CDK 默认的 10.0.0.0/16,与主控区 VPC 逐位相同,跨区 peering 建不出来 ⇒ ` +
    `运行台账回写不了主控区(症状是栈全绿、回写静默超时)。请重新注册一个执行环境替换它,不要重试本次部署。`
  );
}

/** 🔴 open 时必须与 pre-image 逐字节一致的字段(完成方据 openSnapshotHash 证明基线未被顶替)。 */
export const DEPLOY_OPEN_FENCED_FIELDS = Object.freeze([
  "targetId",
  "region",
  "accountId",
  "partition",
  "cellId",
  "stage",
  "isHome",
  "jurisdiction",
  "capabilities",
  "desiredVersion",
  "observedVersion",
  "resources",
  "agentcore",
  "createdBy",
  "credentialIsolationState",
  "credentialEpoch",
  "credentialStateUpdatedAt",
  "provisioningOperationId",
  "provisioningDeadlineAt",
  "lastOperationId",
  "lastBuildId",
]);

function canonicalOpenJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value)) ?? "__undefined__";
}

export function deployOpenSnapshot(target) {
  // @kf-batch 50-WP15-airflow-serverless
  // 🔴 组件清单是**集合**不是序列(memory byte-exact-comparison-traps):开会话的 Update 会把顶层 components 按枚举序重写,
  //    若快照哈希按原序算,post-image 哈希必 ≠ 开会话前算的 openSnapshotHash ⇒ broker 判「无法取得 exact post-image」并**保留 operation**
  //    ⇒ target 卡在 upgrading、无 buildId、恢复要等 2h15m 结构窗。真环境撞到(tgt_usw2_a 补装 airflow-serverless,平台 finalize 写的
  //    顶层序 ≠ 枚举序)。快照里的 components 取**排序副本**:同集合任何序 ⇒ 同哈希。
  return {
    components: Array.isArray(target.components) ? [...target.components].map(String).sort() : target.components,
    ...Object.fromEntries(DEPLOY_OPEN_FENCED_FIELDS.map((field) => [field, target[field]])),
  };
}

export function deployOpenSnapshotHash(target) {
  return createHash("sha256").update(canonicalOpenJson(deployOpenSnapshot(target))).digest("hex");
}

const BROKER_PHASES = new Set(["registered", "provisioning", "verifying", "ready", "draining", "decommissioning", "gone"]);
const BROKER_HEALTHS = new Set(["unknown", "healthy", "degraded"]);
const BROKER_INTENTS = new Set(["serve", "drain", "delete"]);
const BROKER_STATUSES = new Set([
  "registered",
  "initializing",
  "testing",
  "active",
  "degraded",
  "upgrading",
  "draining",
  "decommissioning",
  "deleted",
  "failed",
]);

function normalizeKnownComponents(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Rejected(`注册表 item 的 ${field} 须为${allowEmpty ? "" : "非空"}数组`, "bad-descriptor");
  }
  if (value.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new Rejected(`注册表 item 的 ${field} 含非法元素`, "bad-descriptor");
  }
  if (new Set(value).size !== value.length) {
    throw new Rejected(`注册表 item 的 ${field} 含重复组件`, "bad-descriptor");
  }
  if (value.length > 0 && !value.includes("core")) {
    throw new Rejected(`注册表 item 的 ${field} 非空时必须含 core`, "bad-descriptor");
  }
  const unknown = value.filter((v) => !COMPONENTS.includes(v));
  if (unknown.length) {
    throw new Rejected(`注册表 item 的 ${field} 含未知组件:${unknown.join(",")}`, "bad-descriptor");
  }
  return COMPONENTS.filter((c) => value.includes(c));
}

function isStrictIsoInstant(value) {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function normalizeBrokerProbe(value, field) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    !isStrictIsoInstant(value.at) ||
    typeof value.ok !== "boolean" ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.name !== "string" ||
        item.name.length === 0 ||
        typeof item.ok !== "boolean" ||
        (item.error !== undefined && typeof item.error !== "string")
    )
  ) {
    throw new Rejected(`注册表 item 的 ${field} 必须满足 at/ok/items 的 ProbeResult 形状`, "bad-descriptor");
  }
  if (new Set(value.items.map((item) => item.name)).size !== value.items.length) {
    throw new Rejected(`注册表 item 的 ${field}.items.name 不得重复`, "bad-descriptor");
  }
  if (value.items.some((item) => item.ok === true && item.error !== undefined)) {
    throw new Rejected(`注册表 item 的 ${field} green item 不得携 error`, "bad-descriptor");
  }
  if (value.ok !== value.items.every((item) => item.ok === true)) {
    throw new Rejected(`注册表 item 的 ${field}.ok 与 items 全量结果矛盾`, "bad-descriptor");
  }
  return value;
}

function normalizeBrokerOperation(value, field) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    // @kf-batch 50-WP30-decommission:+destroy(下线销毁会话;与 deploy 同一把锁、同一个 epoch 序列)
    !["deploy", "drain", "destroy"].includes(value.kind) ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    !Number.isInteger(value.lockEpoch) ||
    value.lockEpoch < 1 ||
    (value.openSnapshotHash !== undefined &&
      (typeof value.openSnapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(value.openSnapshotHash))) ||
    (value.kind === "deploy" && value.openSnapshotHash === undefined) ||
    (value.buildId !== undefined && (typeof value.buildId !== "string" || value.buildId.length === 0)) ||
    !isStrictIsoInstant(value.startedAt) ||
    typeof value.disruptive !== "boolean" ||
    (value.startUncertain !== undefined &&
      (!value.startUncertain ||
        typeof value.startUncertain !== "object" ||
        !isStrictIsoInstant(value.startUncertain.at) ||
        typeof value.startUncertain.message !== "string" ||
        value.startUncertain.message.length === 0 ||
        value.startUncertain.message.length > 500)) ||
    (value.attachUncertain !== undefined &&
      (!value.attachUncertain ||
        typeof value.attachUncertain !== "object" ||
        !isStrictIsoInstant(value.attachUncertain.at) ||
        typeof value.attachUncertain.message !== "string" ||
        value.attachUncertain.message.length === 0 ||
        value.attachUncertain.message.length > 500 ||
        typeof value.attachUncertain.candidateBuildId !== "string" ||
        value.attachUncertain.candidateBuildId.length === 0))
  ) {
    throw new Rejected(`注册表 item 的 ${field} 形状非法`, "bad-descriptor");
  }
  if (value.kind === "deploy" && value.disruptive !== true) {
    throw new Rejected(`注册表 item 的 ${field}.deploy 必须 disruptive=true`, "bad-descriptor");
  }
  if (value.kind === "destroy" && (value.disruptive !== true || value.openSnapshotHash !== undefined)) {
    throw new Rejected(`注册表 item 的 ${field}.destroy 必须 disruptive=true 且不带 openSnapshotHash`, "bad-descriptor");
  }
  return value;
}

function legacyAxesForBroker(item) {
  if (
    item.deployLockToken !== undefined ||
    item.deployLockExpiresAt !== undefined ||
    item.deployLockOperationId !== undefined
  ) {
    throw new Rejected("legacy item 残留 deployment lock,禁止 ordinary open", "locked");
  }
  const components = normalizeKnownComponents(item.components, "components");
  const status = String(item.status);
  if (!BROKER_STATUSES.has(status)) {
    throw new Rejected(`注册表 item 的 status 非法:${String(item.status)}`, "bad-descriptor");
  }
  if (item.ready !== undefined && typeof item.ready !== "boolean") {
    throw new Rejected(`注册表 item 的 ready 非布尔:${String(item.ready)}`, "bad-descriptor");
  }

  const probe = normalizeBrokerProbe(item.probe, "probe");

  const serving = status === "active" || status === "degraded";
  const stuckAfterReady = (status === "initializing" || status === "upgrading") && item.ready === true;
  if (stuckAfterReady) {
    throw new Rejected(
      "legacy initializing/upgrading+ready 必须先走本次 fresh probe 收养,broker 禁止凭 stored probe 晋级",
      "needs-fresh-probe"
    );
  }

  let intent = "serve";
  let phase;
  if (serving) {
    if (item.ready !== true) {
      throw new Rejected(`${status}+ready!=true 是损坏 legacy descriptor`, "bad-descriptor");
    }
    phase = "ready";
  } else if (status === "registered") {
    phase = "registered";
  } else if (status === "testing") {
    phase = "verifying"; // 不跳过 enable
  } else if (status === "initializing" && item.ready !== true) {
    phase = "provisioning";
  } else if (status === "draining") {
    intent = "drain";
    phase = "draining";
  } else if (status === "decommissioning") {
    intent = "delete";
    phase = "decommissioning";
  } else if (status === "deleted") {
    intent = "delete";
    phase = "gone";
  } else {
    // failed、upgrading+ready=false 等必须走 probe/recovery,ordinary broker 不重开。
    throw new Rejected(`legacy status=${status},ready=${String(item.ready)} 不允许 ordinary deploy`, "bad-status");
  }

  return {
    ifAbsent: true,
    spec: { intent, desiredComponents: components },
    observed: {
      phase,
      health: phase === "ready" ? (status === "degraded" ? "degraded" : "healthy") : "unknown",
      components,
      ...(probe ? { probe } : {}),
    },
  };
}

/**
 * 🔴 顶层兼容投影 —— **必须与平台侧 `lifecycle.deriveStatusProjection`/`deriveReady` 逐格一致**
 * (两侧是同一份投影的镜像;跨构建边界无法共享代码,故由
 *  `platform/src/lib/exec-env/__tests__/projection-parity.test.ts` 真 import 本文件、跑**全交叉积**钉死)。
 * 🔴 P50.3b-2b 订正:`ready` 分支原写 `health === "degraded" ? "degraded" : "active"` ⇒
 *    `ready + health="unknown"` 被投影成 **active**,与平台侧(只有 healthy 才 active)分叉,
 *    于是"顶层投影与 spec/observed 不一致"会独立抛 bad-descriptor。
 *    `ready+unknown` 自 P50.3b-2a 起是**合法且可达**的 fail-closed 健康态(核心探活连红 2 tick),
 *    2b 的失败恢复也会产生它 —— 投影必须如实落 `degraded`,绝不冒充 active。
 */
export function materializedBrokerProjection(spec, observed) {
  let status;
  // 🔴 与平台侧 `deriveStatusProjection` 逐格同构(252 格 parity 门禁钉住)。
  //    intent 优先于"服务中"类 phase:意图不是 serve 时顶层 status 绝不能还写 active/testing/initializing
  //    —— 兼容投影是给老 readers 判可用的,写 active = 对已排空环境 fail-open(真环境实测揪出)。
  //    统一投 `draining`(逐字为真:不再承接新工作),不投 `decommissioning`(那暗示正在销毁 = 谎)。
  if (spec.intent !== "serve" && ["registered", "provisioning", "verifying", "ready"].includes(observed.phase)) {
    return {
      status: "draining",
      ready: ["ready", "draining", "decommissioning"].includes(observed.phase),
      components: observed.components,
    };
  }
  switch (observed.phase) {
    case "registered":
      status = observed.lastError ? "failed" : "registered";
      break;
    case "provisioning":
      status = observed.lastError ? "failed" : "initializing";
      break;
    case "verifying":
      status = "testing";
      break;
    case "ready":
      status = observed.operation ? "upgrading" : observed.health === "healthy" ? "active" : "degraded";
      break;
    case "draining":
      status = "draining";
      break;
    case "decommissioning":
      status = "decommissioning";
      break;
    case "gone":
      status = "deleted";
      break;
    default:
      throw new Rejected(`observed.phase 非法:${observed.phase}`, "bad-descriptor");
  }
  return {
    status,
    ready: ["ready", "draining", "decommissioning"].includes(observed.phase),
    components: observed.components,
  };
}

function assertBrokerModernInvariants(item, spec, observed) {
  const operation = observed.operation;
  if (operation) {
    if (!Number.isInteger(item.deployLockExpiresAt) || item.deployLockExpiresAt <= 0) {
      throw new Rejected("observed.operation 存在但顶层 deployLockExpiresAt 缺失/非法", "bad-descriptor");
    }
    if (
      item.lockEpoch !== operation.lockEpoch ||
      item.deployLockToken !== operation.operationId ||
      item.deployLockOperationId !== operation.operationId
    ) {
      throw new Rejected("observed.operation 与顶层 lockEpoch/token/owner 不一致", "bad-descriptor");
    }
  } else if (
    item.deployLockToken !== undefined ||
    item.deployLockExpiresAt !== undefined ||
    item.deployLockOperationId !== undefined
  ) {
    throw new Rejected("modern 无 operation 却残留顶层 active lock", "bad-descriptor");
  }
  // 🔴 P50.3b-2b **删除**原先的 `ready+health=unknown ⇒ bad-descriptor` 断言。
  //    它写下时 `ready` 只能由"完成 fence(要求 health=healthy)"到达,故该形状确实不可达 = 视为数据损坏。
  //    但 P50.3b-2a 起 `health` 是**独立的轴**:核心探活连红 2 tick 就把 ready target 的 health 降到
  //    `unknown`(fail-closed 不承接新工作);2b 的失败恢复也刻意写这个形状。
  //    ⇒ 该不变量已过期,继续留着的后果是**掐死唯一的修复路径**:一个探活变红/部署失败的 region
  //    连"重新部署去修它"都会被 broker 判 bad-descriptor(HTTP 500),运维只能手改 DDB —— 正是
  //    P50.3b 要根治的"永久卡死"换个门重生(P50.2e3 同款教训:任何状态都必须留一条重试路)。
  //    🔴 语义分工:**不承接业务下推 ≠ 不允许运维部署**。前者由平台 `serviceabilityReason`
  //    (health∉{healthy,degraded} 一律拒)把住,与本处放行互不矛盾;并发安全仍由锁/operation 校验把住。
  if (observed.components.some((component) => !spec.desiredComponents.includes(component))) {
    throw new Rejected("observed.components 超出 desired", "bad-descriptor");
  }
  const deploy = observed.operation?.kind === "deploy" ? observed.operation : undefined;
  if (
    deploy?.buildId !== undefined &&
    (item.lastOperationId !== deploy.operationId || item.lastBuildId !== deploy.buildId)
  ) {
    throw new Rejected("已 attach deploy 与顶层 lastOperationId/lastBuildId 不一致", "bad-descriptor");
  }
  if (deploy && (spec.intent !== "serve" || !["provisioning", "ready"].includes(observed.phase))) {
    throw new Rejected("deploy operation 的 intent/phase 不一致", "bad-descriptor");
  }
  // @kf-batch 50-WP30-decommission:销毁会话只可能长在 intent=delete ∧ phase=decommissioning 上
  if (observed.operation?.kind === "destroy" && (spec.intent !== "delete" || observed.phase !== "decommissioning")) {
    throw new Rejected("destroy operation 的 intent/phase 不一致", "bad-descriptor");
  }
  if (observed.phase === "provisioning" && !deploy && !observed.lastError) {
    throw new Rejected("provisioning 无 deploy operation/lastError", "bad-descriptor");
  }
  const projection = materializedBrokerProjection(spec, observed);
  // @kf-batch 50-WP15-airflow-serverless
  // 🔴 跨来源比较必须 canonical(组件清单是**集合**不是序列):顶层 `components` 由平台侧 finalize 按其 IMPLEMENTED 序写,
  //    而 `observed.components` 在 axesForBroker 入口已按枚举序归一 ⇒ 两个「各自规范」的序列逐字节比必炸。
  //    真环境撞到:tgt_usw2_a 经页面补装 mwaa(平台 finalize 写 core,redshift,dms,flink,mwaa)之后,第一次再经 broker
  //    (补装 airflow-serverless)即 bad-descriptor「顶层投影与 spec/observed 不一致」—— 描述符本身完全一致,只是序不同。
  //    两侧都过同一 normalizeKnownComponents 再比;E-49 向量 ⑪ 钉「同集合不同序不判 bad-descriptor」。
  const topComponents = normalizeKnownComponents(item.components, "components", { allowEmpty: true });
  if (
    item.status !== projection.status ||
    item.ready !== projection.ready ||
    JSON.stringify(topComponents) !== JSON.stringify(projection.components)
  ) {
    throw new Rejected("modern 顶层投影与 spec/observed 不一致", "bad-descriptor");
  }
}

function axesForBroker(item) {
  const hasSpec = item?.spec !== undefined;
  const hasObserved = item?.observed !== undefined;

  // 🔴 单轴存在是损坏的新 item,不是 legacy。
  if (hasSpec !== hasObserved) {
    throw new Rejected("注册表 item 的 spec/observed 只存在一侧,拒绝按 legacy 猜测", "bad-descriptor");
  }
  if (!hasSpec) return legacyAxesForBroker(item);

  const spec = item.spec;
  const observed = item.observed;
  if (!spec || typeof spec !== "object" || !observed || typeof observed !== "object") {
    throw new Rejected("注册表 item 的 spec/observed 形状非法", "bad-descriptor");
  }
  if (!BROKER_INTENTS.has(spec.intent)) {
    throw new Rejected(`spec.intent 非法:${String(spec.intent)}`, "bad-descriptor");
  }
  if (!BROKER_PHASES.has(observed.phase)) {
    throw new Rejected(`observed.phase 非法:${String(observed.phase)}`, "bad-descriptor");
  }
  if (!BROKER_HEALTHS.has(observed.health)) {
    throw new Rejected(`observed.health 非法:${String(observed.health)}`, "bad-descriptor");
  }

  const normalizedObserved = {
    ...observed,
    components: normalizeKnownComponents(observed.components, "observed.components", { allowEmpty: true }),
  };
  const normalizedProbe = normalizeBrokerProbe(observed.probe, "observed.probe");
  if (normalizedProbe === undefined) delete normalizedObserved.probe;
  else normalizedObserved.probe = normalizedProbe;
  const normalizedOperation = normalizeBrokerOperation(observed.operation, "observed.operation");
  if (normalizedOperation === undefined) delete normalizedObserved.operation;
  else normalizedObserved.operation = normalizedOperation;

  const normalizedSpec = {
    ...spec,
    desiredComponents: normalizeKnownComponents(spec.desiredComponents, "spec.desiredComponents"),
  };
  assertBrokerModernInvariants(item, normalizedSpec, normalizedObserved);
  return {
    ifAbsent: false,
    spec: normalizedSpec,
    observed: normalizedObserved,
  };
}

/**
 * 只规划"打开 deploy operation"这一条命令,不碰 AWS。
 * req 必须已经过 validateInput(),epoch 是本次即将持有的新 fencing epoch。
 */
export function planDeployOpen(item, req, epoch, nowIso, sourceRef) {
  if (!Number.isInteger(item?.version)) {
    throw new Rejected(`注册表 item 缺整数 version:${String(item?.version)}`, "bad-descriptor");
  }
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new Rejected(`lockEpoch 非法:${String(epoch)}`, "bad-descriptor");
  }
  if (!isStrictIsoInstant(nowIso)) {
    throw new Rejected(`nowIso 非法:${String(nowIso)}`, "bad-descriptor");
  }
  const openSnapshotHash = deployOpenSnapshotHash(item);

  const current = axesForBroker(item);
  const { spec, observed } = current;
  if (spec.intent !== "serve") {
    throw new Rejected(`执行目标 ${item.targetId} 的 intent=${spec.intent} 不允许部署`, "bad-status");
  }
  if (observed.operation) {
    throw new Rejected(`执行目标已有 lifecycle operation=${observed.operation.operationId ?? "unknown"}`, "locked");
  }

  // broker 收到的是 desired 全集;不得借重部署摘掉已有 desired 或 observed 组件。
  const required = [...spec.desiredComponents, ...observed.components].filter((v, i, a) => a.indexOf(v) === i);
  const dropped = required.filter((c) => !req.components.includes(c));
  if (dropped.length) {
    throw new Rejected(`components 不得摘掉既有 desired/observed 组件:${dropped.join(",")}`, "bad-components");
  }
  // @kf-batch 50-PROD-B-seq33 ② —— 🔴🔴 不提供精简形态(用户 2026-10-10):下发集必须 ⊇ 完整组件集。
  //   平台入口(注册 / 补齐 / deploy)已判一次;这里是 broker 这道纵深锁(平台可能被绕)。
  const lacking = requiredComponentsForItem(item).filter((c) => !req.components.includes(c));
  if (lacking.length) {
    throw new Rejected(
      `components 缺少完整组件集里的 ${lacking.join(",")}(每个执行环境都必须装齐,不提供精简形态)`,
      "bad-components"
    );
  }

  let toPhase;
  if (observed.phase === "ready") toPhase = "ready"; // 🔴 bug#11 根治
  else if (["registered", "provisioning", "verifying"].includes(observed.phase)) {
    toPhase = "provisioning";
  } else {
    throw new Rejected(`执行目标 ${item.targetId} 的 phase=${observed.phase} 不允许部署`, "bad-status");
  }

  const nextObserved = {
    ...observed,
    phase: toPhase,
    ...(toPhase === "ready" ? {} : { health: "unknown" }),
    operation: {
      kind: "deploy",
      operationId: req.operationId,
      lockEpoch: epoch,
      openSnapshotHash,
      startedAt: nowIso,
      // P0-E 未落地前恒 true。
      disruptive: true,
      // 🔴 P0-E ④(SPEC §3.5c):本次部署用的**源包身份**(CodeBuild 项目级 env,broker 只转录不判断)。
      //    成功栅栏会把它提升为 `observed.baselineRef`("现实里装的是哪一份源");失败一律不动。
      //    缺省(未注入)时**不落这个字段** —— 绝不写一个空串假装知道。
      ...(typeof sourceRef === "string" && sourceRef.length > 0 ? { sourceRef } : {}),
    },
  };
  delete nextObserved.lastError;

  const nextSpec = {
    ...spec,
    intent: "serve",
    desiredComponents: [...req.components],
  };

  return {
    ifAbsent: current.ifAbsent,
    fromPhase: observed.phase,
    expectedVersion: item.version,
    nextVersion: item.version + 1,
    post: { spec: nextSpec, observed: nextObserved },
    projection: {
      status: toPhase === "ready" ? "upgrading" : "initializing",
      ready: toPhase === "ready",
      components: [...nextObserved.components],
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-WP30-decommission —— planDestroyOpen:下线销毁(WP-30 路 B)的开会话规划
//   与 planDeployOpen 同一纪律:零 AWS、零项目依赖;index.mjs 只消费 plan、发 AWS。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 最终快照名形态(Redshift Serverless 快照名:小写字母开头,`[a-z0-9-]`,不许连字符结尾 / 连续连字符)。
 * 名字由平台在**审批通过**那一刻生成(`bgp-final-<slug>-<yyyymmdd>-<hhmm>`)并落进注册表的删除计划;
 * broker 只校验形态、照抄给 build —— 重试销毁复用同一个名字 ⇒ 快照不会被重复创建。
 */
export const FINAL_SNAPSHOT_RE = /^bgp-final-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 能进入销毁的阶段:装过 / 装到一半(有栈)/ 上一次销毁卡住。`registered` 没部署过 ⇒ 走弃置(路 A);`gone` 是终态。 */
export const DESTROYABLE_PHASES = new Set(["ready", "draining", "provisioning", "verifying", "decommissioning"]);

/**
 * 只规划「打开 destroy operation」这一条命令,不碰 AWS。
 * req 必须已经过 validateInput()(mode=destroy),epoch 是本次即将持有的新 fencing epoch。
 * 🔴 承重:
 *   ① home 永不可删(validateInput 已拒 tgt_home;这里再按描述符 `isHome` 拒一次 —— 两道锁);
 *   ② 只认 `spec.intent === "delete"` ∧ 注册表有删除计划(`decommission.approvalId` + 合法最终快照名)——
 *      平台把 intent 置成 delete 的唯一入口是**审批通过**,所以「没审批就销毁」在这里结构上走不通;
 *   ③ legacy(无双轴)描述符一律拒:销毁会话必须能被平台的收口 fence 精确绑定;
 *   ④ 销毁哪些组件 = 描述符 desired ∪ observed(不从入参取)。
 */
export function planDestroyOpen(item, req, epoch, nowIso, sourceRef) {
  if (req?.mode !== "destroy") throw new Rejected("planDestroyOpen 只接 mode=destroy 的请求", "rejected");
  if (!Number.isInteger(item?.version)) {
    throw new Rejected(`注册表 item 缺整数 version:${String(item?.version)}`, "bad-descriptor");
  }
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new Rejected(`lockEpoch 非法:${String(epoch)}`, "bad-descriptor");
  }
  if (!isStrictIsoInstant(nowIso)) {
    throw new Rejected(`nowIso 非法:${String(nowIso)}`, "bad-descriptor");
  }
  if (item.isHome === true || item.targetId === "tgt_home") {
    throw new Rejected("主控区执行环境永不可删", "bad-status");
  }
  const current = axesForBroker(item);
  if (current.ifAbsent) {
    throw new Rejected(
      `执行目标 ${item.targetId} 还是 legacy 描述符(无 spec/observed)—— 先「检测初始化」让平台收养,再申请删除`,
      "needs-fresh-probe"
    );
  }
  const { spec, observed } = current;
  if (spec.intent !== "delete") {
    throw new Rejected(
      `执行目标 ${item.targetId} 的 intent=${spec.intent},不是 delete —— 销毁必须先经删除审批(审批通过是平台写 intent=delete 的唯一入口)`,
      "bad-status"
    );
  }
  const plan = item.decommission;
  if (!plan || typeof plan !== "object" || typeof plan.approvalId !== "string" || plan.approvalId.length === 0) {
    throw new Rejected(`执行目标 ${item.targetId} 的注册表里没有删除计划(decommission.approvalId)—— 拒绝无审批的销毁`, "bad-descriptor");
  }
  if (typeof plan.finalSnapshotName !== "string" || !FINAL_SNAPSHOT_RE.test(plan.finalSnapshotName) || plan.finalSnapshotName.length > 255) {
    throw new Rejected(`删除计划里的最终快照名非法:${JSON.stringify(plan.finalSnapshotName)}`, "bad-descriptor");
  }
  if (observed.operation) {
    throw new Rejected(`执行目标已有 lifecycle operation=${observed.operation.operationId ?? "unknown"}(销毁会话在跑或部署未收口)`, "locked");
  }
  if (!DESTROYABLE_PHASES.has(observed.phase)) {
    throw new Rejected(
      observed.phase === "registered"
        ? `执行目标 ${item.targetId} 从没部署过(phase=registered)—— 走「弃置」而不是销毁`
        : `执行目标 ${item.targetId} 的 phase=${observed.phase} 不允许销毁`,
      "bad-status"
    );
  }

  const components = COMPONENTS.filter((c) => spec.desiredComponents.includes(c) || observed.components.includes(c));
  const nextObserved = {
    ...observed,
    phase: "decommissioning",
    health: "unknown",
    operation: {
      kind: "destroy",
      operationId: req.operationId,
      lockEpoch: epoch,
      startedAt: nowIso,
      disruptive: true,
      ...(typeof sourceRef === "string" && sourceRef.length > 0 ? { sourceRef } : {}),
    },
  };
  // 新一轮销毁:上一轮卡住的原因作废(新结果由平台收口时重写);不删 lastDestroy(历史诊断,收口时覆盖)
  delete nextObserved.lastError;
  const projection = materializedBrokerProjection(spec, nextObserved);
  return {
    fromPhase: observed.phase,
    expectedVersion: item.version,
    nextVersion: item.version + 1,
    post: { spec, observed: nextObserved },
    projection: { ...projection, components: [...projection.components] },
    components,
    finalSnapshotName: plan.finalSnapshotName,
    approvalId: plan.approvalId,
  };
}
