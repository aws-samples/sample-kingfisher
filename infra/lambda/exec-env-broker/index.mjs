// @kf-batch 50-P50.3b-lifecycle-rootfix(前身 50-P50.2b/c:窄权 broker + 拆纯函数)
// 执行环境部署 **broker**(50 DESIGN §12.0「更稳」修法② + P50.3b 写序焊死)。
//
// 【为什么必须有 broker,而不是让平台直接持 codebuild:StartBuild】
//   IR-P0-05 坐实:`StartBuild` API **自带** `buildspecOverride`(可 inline 明文)、`imageOverride`、
//   `serviceRoleOverride`、`sourceLocationOverride`… ⇒ 拿到平台 ECS 凭证的攻击者可以 inline 一段
//   恶意 buildspec,借 CodeBuild 的 **admin-equivalent 服务角色**执行任意部署。
//   **应用层参数白名单挡不住直接调 AWS API 的人**。
//   ⇒ 定案:平台 ECS **完全不持 StartBuild**,只有 `lambda:InvokeFunction` 到本 broker;
//     StartBuild 由 broker 独家持有,且 broker **只接三个白名单入参**、**绝不透传任何 caller 提供的 override**。
//
// 🔴 本文件的承重(P50.2 四条 + P50.3b 写序):
// ① 入参白名单:只认 `{targetId, components[], operationId}`,多一个字段就拒;
// ② **region / account 一律从注册表读**,绝不从入参取;
// ③ **部署锁**(§12.2 P0-C)+ ④ **fencing epoch**(§3.5):锁在 broker 抢、每次递增 epoch。
// ⑤ 🔴 **P50.3b 写序(v2 审核拍板 C / §4.2 / §19)**:read → `planDeployOpen`(纯函数,validate.mjs)→
//    **单次条件写开 `observed.operation` + 锁**(operation **先于** StartBuild 落库)→ StartBuild(带
//    幂等 token)→ 按 exact op/epoch 附 `buildId`。`cb.send` 抛错=受理未知 ⇒ 写 `startUncertain`、
//    **绝不清 operation/锁**。**绝不** `acquire lock → StartBuild → best-effort mark`(那有"基础设施在变、
//    target 仍被准入"的窗口,且 mark 失败会永久丢 operation 事实)。旧 `markInitializing`(写 legacy
//    `status=initializing`)与旧"直接换锁 takeover"已删除:状态由投影派生、陈锁走 §19.7 分类恢复。
//
// 🔴 所有**不碰 AWS 的判定**在 `./validate.mjs`(零依赖纯函数 + 仅 node:crypto,E-49/synth-gate 原生
//    import 真执行);本文件只做"取数 → 调 planner 判定 → 发 AWS 调用 + 条件写"的接线。
import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } from "@aws-sdk/client-codebuild";
import {
  Rejected,
  validateInput,
  validateTargetDescriptor,
  vpcCidrRejection,
  translateLockError,
  staleLockCandidate,
  isTerminalBuildStatus,
  planDeployOpen,
  DEPLOY_OPEN_FENCED_FIELDS,
  deployOpenSnapshotHash,
  // @kf-batch 50-WP30-decommission
  planDestroyOpen,
} from "./validate.mjs";

const REGION = process.env.AWS_REGION;
const TABLE = process.env.EXEC_ENV_TABLE;
const PROJECT = process.env.EXEC_ENV_PROJECT;
const AUDIT_TABLE = process.env.AUDIT_TABLE;
const PK = "env";

/**
 * 顶层 `deployLockExpiresAt` 的取值 = `operation.startedAt + LOCK_LEASE_MS`(强读回按此式逐字校验)。
 *
 * 🔴 **它是诊断性的"预期完成时限",不驱动任何自动释放/接管**(SPEC §3.5b;P50.3b-2b 订正):
 *   · 普通 open 路径只接受"无锁"(`attribute_not_exists(deployLockToken)`),从不看它过没过期;
 *   · 陈锁只能走 §19.7 分类 + 管理员恢复端点(CodeBuild terminal ≠ CloudFormation 已稳定/已回滚)。
 *   ⇒ **绝不要**把 `OR deployLockExpiresAt < :now` 加回条件里:那会让"锁过期"变成自动接管 = fail-open。
 *   ⇒ 也**刻意不做续租**:没有读者需要它续,且续了会让它 ≠ `startedAt + LOCK_LEASE_MS`,
 *     打破 `matchesOpenedDeploySession` 的 exact 读回(no-build 5min 重发路径会失效)。
 *
 * 🔴 故它必须 ≥ CodeBuild 项目超时(`infra/lib/exec-env/deploy-stack.ts` 的 `timeout: Duration.hours(2)`)+ 裕度。
 *   原值 90min < 2h 正是个错:一个合法的 100 分钟 build 会显示成"已过期",诱使后人加回那条 fail-open 条件。
 *   平台侧 `EXEC_ENV_BUILD_TIMEOUT_MS` 与本值同源(各有契约测钉住 infra 字面量)。
 */
/**
 * 🔴 P0-E ④:本次控制面锁定的**源包身份**(CDK 部署 ExecEnvDeployStack 时注入;换 commit ⇒ 换哈希)。
 *    broker 只把它转录进 operation 与 build 入参,**不做任何判断**(判定属共享判据,在 build 侧与平台侧)。
 */
const SOURCE_REF = process.env.EXEC_ENV_SOURCE_REF || "";
// @kf-batch 50-WP15-airflow-serverless(K-5 网络规模)
// @kf-batch 50-WP16-zero-egress:`networkProfile` → NAT 数这条链**已退役**(SPEC §3.16:执行环境零出网,
// NAT 恒为 0)。注册表字段保留只为兼容存量描述符,broker 不再读它、也不再注入 EXEC_ENV_NAT_GATEWAYS。
// 🔴 **刻意不把它放进 environmentVariablesOverride**:build 侧那份必须来自 **CodeBuild 项目定义**
//    (平台角色没有 UpdateProject ⇒ §12.0 同级保护),override 会遮蔽它、等于把基线判定的输入
//    交给调用方左右。broker 这份只用来**转录进 operation**,给成功栅栏提升成 baselineRef 用。

const LOCK_LEASE_MS = 135 * 60_000; // 2h15m = 项目超时 2h + 15min 裕度

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cb = new CodeBuildClient({ region: REGION });

export const handler = async (event) => {
  try {
    const req = validateInput(event);
    const target = await readTargetForDeploy(req.targetId);

    // @kf-batch 50-WP30-decommission —— 下线销毁(WP-30 路 B)。放在 vpcCidr 守卫**之前**:
    //   缺 vpcCidr 的存量环境部署不出来,但**必须删得掉**(否则它永远占着这个区的名额)。
    if (req.mode === "destroy") return await handleDestroy(req, target);

    // @kf-batch 50-WP23-xregion-peering —— 缺 vpcCidr 的存量描述符一律拒(preview 也拒:它照样要 synth)
    const cidrBlocked = vpcCidrRejection(target);
    if (cidrBlocked) throw new Rejected(cidrBlocked, "bad-descriptor");

    // ── 🔴 P0-E preview 旁路(P50.3b-3;SPEC §3.5c):预演**不执行任何变更** ⇒ 不开 operation、不上锁、不涨 epoch。
    //    但必须**拒绝与在途会话并跑**:预演会在同一批栈上创建 change set,与正在跑的部署撞(CFN 会拒,
    //    更糟的是它可能给恢复闸留下"存在未执行 change set"的假象)。⇒ 有 operation / 有残留锁 ⇒ 直接拒。
    if (req.mode === "preview") {
      const previewBlock = previewBlockedReason(target);
      if (previewBlock) throw new Rejected(previewBlock, "locked");
      const build = await startBuild(target, req, undefined);
      await audit({ ok: true, req, target: pickTarget(target), epoch: null, buildId: build.id, warning: "preview" });
      return { ok: true, buildId: build.id, lockEpoch: null, targetId: target.targetId, region: target.region, mode: "preview" };
    }

    const { epoch, plan, sessionTarget, sessionVersion } = await openDeploySessionWithRecovery(target, req);

    let build;
    try {
      build = await startBuild(sessionTarget, req, epoch);
    } catch (error) {
      // 🔴 SDK throw 可能发生在请求已被服务端受理后;默认按"不确定"处理,不清 operation/锁(§19.6)。
      await recordStartUncertainFailure(sessionTarget.targetId, req.operationId, epoch, plan, sessionVersion, error).catch(
        (recordError) => {
          console.log(
            JSON.stringify({
              kind: "exec-env-deploy-broker",
              at: new Date().toISOString(),
              recordStartFailureFailed: String(recordError?.message || recordError),
            })
          );
        }
      );
      throw error;
    }

    const warning = await attachBuildId(sessionTarget.targetId, req.operationId, epoch, plan, sessionVersion, build.id);

    await audit({ ok: true, req, target: pickTarget(sessionTarget), epoch, buildId: build.id, warning });
    return {
      ok: true,
      buildId: build.id,
      lockEpoch: epoch,
      targetId: sessionTarget.targetId,
      region: sessionTarget.region,
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    const code = error instanceof Rejected ? error.code : "error";
    await audit({ ok: false, err: String(error?.message || error), code, event }).catch(() => {});
    // 🔴 不把内部细节回给调用方以外的信息;但**必须**让调用方能区分"被拒"与"故障"。
    return { ok: false, code, message: String(error?.message || error) };
  }
};

// ── 读:raw / descriptor-validated 两层(§19.5)──
// attach 后读回必须绕过普通 admission(post-open target 本就应被普通部署准入判 locked)。
async function readTargetRaw(targetId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, sk: targetId }, ConsistentRead: true }));
  return Item ?? null;
}
async function readTargetForDeploy(targetId) {
  return validateTargetDescriptor(await readTargetRaw(targetId), targetId);
}

// ══════════════════════════════════════════════════════════════════════════════
// 开部署会话:锁 + operation 同一次条件写(operation 先于 StartBuild)(§19.2)
// ══════════════════════════════════════════════════════════════════════════════

function canonicalSessionJson(value) {
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

function matchesOpenedDeploySession(current, openedFrom, req, epoch, plan) {
  const operation = current?.observed?.operation;
  const expectedSnapshotHash = deployOpenSnapshotHash(openedFrom);
  return (
    operation?.openSnapshotHash === expectedSnapshotHash &&
    deployOpenSnapshotHash(current) === expectedSnapshotHash &&
    current?.targetId === req.targetId &&
    current?.region === openedFrom.region &&
    current?.accountId === openedFrom.accountId &&
    current?.partition === openedFrom.partition &&
    current?.isHome === openedFrom.isHome &&
    current?.jurisdiction === openedFrom.jurisdiction &&
    canonicalSessionJson(current?.resources) === canonicalSessionJson(openedFrom.resources) &&
    canonicalSessionJson(current?.agentcore) === canonicalSessionJson(openedFrom.agentcore) &&
    current?.version === plan.nextVersion &&
    current?.lockEpoch === epoch &&
    current?.deployLockToken === req.operationId &&
    current?.deployLockOperationId === req.operationId &&
    current?.deployLockExpiresAt === Date.parse(plan.post.observed.operation.startedAt) + LOCK_LEASE_MS &&
    current?.updatedAt === plan.post.observed.operation.startedAt &&
    operation?.kind === "deploy" &&
    operation.operationId === req.operationId &&
    operation.lockEpoch === epoch &&
    operation.startedAt === plan.post.observed.operation.startedAt &&
    operation.buildId === undefined &&
    canonicalSessionJson(current.spec) === canonicalSessionJson(plan.post.spec) &&
    canonicalSessionJson(current.observed) === canonicalSessionJson(plan.post.observed) &&
    current.status === plan.projection.status &&
    current.ready === plan.projection.ready &&
    canonicalSessionJson(current.components) === canonicalSessionJson(plan.projection.components)
  );
}

export function buildOpenDeploySessionUpdate(target, req, epoch, nowIso) {
  const oldEpoch = target.lockEpoch;
  if (oldEpoch !== undefined && !Number.isInteger(oldEpoch)) {
    throw new Rejected(`注册表 lockEpoch 非整数:${String(oldEpoch)}`, "bad-descriptor");
  }
  if (epoch !== Number(oldEpoch ?? 0) + 1) {
    throw new Rejected("open epoch 与 target pre-image 不连续", "bad-descriptor");
  }
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== nowIso) {
    throw new Rejected("nowIso 必须是 canonical ISO", "bad-descriptor");
  }
  const plan = planDeployOpen(target, req, epoch, nowIso, SOURCE_REF);

  // 🔴 DynamoDB 会拒绝未被表达式使用的 names/values;这里只放所有分支都使用的项。
  const names = {
    "#o": "observed",
    "#sp": "spec",
    "#status": "status",
    "#ready": "ready",
    "#components": "components",
    "#region": "region",
    "#accountId": "accountId",
    "#partition": "partition",
    "#version": "version",
    "#lockEpoch": "lockEpoch",
  };
  const values = {
    ":obs": plan.post.observed,
    ":spec": plan.post.spec,
    ":status": plan.projection.status,
    ":ready": plan.projection.ready,
    ":components": plan.projection.components,
    ":currentTopComponents": target.components,
    ":expectedRegion": target.region,
    ":expectedAccountId": target.accountId,
    ":expectedPartition": target.partition,
    ":expectedVersion": plan.expectedVersion,
    ":nextVersion": plan.nextVersion,
    ":epoch": epoch,
    ":token": req.operationId,
    ":expires": now + LOCK_LEASE_MS,
    ":operationId": req.operationId,
    ":nowIso": nowIso,
  };

  const epochCondition = oldEpoch === undefined ? "attribute_not_exists(#lockEpoch)" : "#lockEpoch = :oldEpoch";
  if (oldEpoch !== undefined) values[":oldEpoch"] = oldEpoch;

  const snapshotConditions = [];
  DEPLOY_OPEN_FENCED_FIELDS.forEach((field, index) => {
    const name = `#openSnapshot${index}`;
    names[name] = field;
    const value = target[field];
    if (value === undefined) {
      snapshotConditions.push(`attribute_not_exists(${name})`);
    } else {
      const valueName = `:openSnapshot${index}`;
      values[valueName] = value;
      snapshotConditions.push(`${name} = ${valueName}`);
    }
  });

  let lifecycleCondition;
  if (plan.ifAbsent) {
    // 收养判定读过 status/ready/components/probe;raw probe 不涨 version,所以必须逐项绑定。
    values[":legacyStatus"] = target.status;
    values[":legacyComponents"] = target.components;
    lifecycleCondition =
      "attribute_not_exists(#o) AND attribute_not_exists(#sp) " +
      "AND #status = :legacyStatus AND #components = :legacyComponents";

    if (target.ready === undefined) {
      lifecycleCondition += " AND attribute_not_exists(#ready)";
    } else {
      values[":legacyReady"] = target.ready;
      lifecycleCondition += " AND #ready = :legacyReady";
    }

    names["#probe"] = "probe";
    if (target.probe === undefined) {
      lifecycleCondition += " AND attribute_not_exists(#probe)";
    } else {
      values[":legacyProbe"] = target.probe;
      lifecycleCondition += " AND #probe = :legacyProbe";
    }
  } else {
    values[":currentObserved"] = target.observed;
    values[":currentSpec"] = target.spec;
    lifecycleCondition = "#o = :currentObserved AND #sp = :currentSpec";
  }

  const command = new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, sk: target.targetId },
    UpdateExpression:
      "SET deployLockToken = :token, deployLockExpiresAt = :expires, " +
      "deployLockOperationId = :operationId, #lockEpoch = :epoch, " +
      "#o = :obs, #sp = :spec, #status = :status, #ready = :ready, " +
      "#components = :components, #version = :nextVersion, updatedAt = :nowIso",
    ConditionExpression:
      "attribute_exists(sk) AND attribute_not_exists(deployLockToken) AND " +
      "attribute_not_exists(deployLockExpiresAt) AND " +
      "attribute_not_exists(deployLockOperationId) AND " +
      "#version = :expectedVersion AND #region = :expectedRegion AND " +
      "#accountId = :expectedAccountId AND #partition = :expectedPartition AND " +
      "#components = :currentTopComponents AND " +
      snapshotConditions.join(" AND ") +
      " AND " +
      epochCondition +
      " AND " +
      lifecycleCondition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  });
  return { plan, command };
}

async function openDeploySession(target, req) {
  const oldEpoch = target.lockEpoch;
  if (oldEpoch !== undefined && !Number.isInteger(oldEpoch)) {
    throw new Rejected(`注册表 lockEpoch 非整数:${String(oldEpoch)}`, "bad-descriptor");
  }
  const epoch = Number(oldEpoch ?? 0) + 1;
  const nowIso = new Date().toISOString();
  const { plan, command } = buildOpenDeploySessionUpdate(target, req, epoch, nowIso);

  let opened;
  try {
    opened = await ddb.send(command);
  } catch (error) {
    // Update 响应可能丢失:强读回,exact post-image 匹配才算幂等成功。
    const current = await readTargetRaw(target.targetId).catch(() => null);
    if (matchesOpenedDeploySession(current, target, req, epoch, plan)) {
      return { epoch, plan, sessionTarget: current, sessionVersion: plan.nextVersion };
    }
    const rejected = translateLockError(error, target);
    if (rejected) throw rejected;
    throw error;
  }

  const sessionTarget = opened?.Attributes ?? (await readTargetRaw(target.targetId).catch(() => null));
  if (!matchesOpenedDeploySession(sessionTarget, target, req, epoch, plan)) {
    throw new Rejected("open Update 成功但无法取得 exact post-image;保留 operation 并停止 StartBuild", "locked");
  }
  return { epoch, plan, sessionTarget, sessionVersion: plan.nextVersion };
}

// ══════════════════════════════════════════════════════════════════════════════
// 陈锁/在途会话恢复分类(§19.7):普通 handler 禁止 takeover,只分类
// ══════════════════════════════════════════════════════════════════════════════

async function readExactBuildStatus(buildId) {
  try {
    const out = await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    return out.builds?.[0]?.buildStatus ?? "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function sameComponentList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 同一请求的 no-build session,在 SDK 5min token 窗口内可原样重发(不开新 op、不换 epoch、不延长窗口)。 */
function resumableUnattachedStart(target, req, nowMs = Date.now()) {
  const operation = target.observed?.operation;
  if (
    operation?.kind !== "deploy" ||
    operation.operationId !== req.operationId ||
    operation.buildId !== undefined ||
    !Number.isInteger(operation.lockEpoch) ||
    operation.lockEpoch < 1 ||
    operation.disruptive !== true ||
    !["provisioning", "ready"].includes(target.observed?.phase) ||
    target.spec?.intent !== "serve" ||
    !sameComponentList(target.spec.desiredComponents, req.components) ||
    target.lockEpoch !== operation.lockEpoch ||
    target.deployLockToken !== operation.operationId ||
    target.deployLockOperationId !== operation.operationId ||
    !Number.isInteger(target.deployLockExpiresAt) ||
    target.deployLockExpiresAt <= 0 ||
    !/^[a-f0-9]{64}$/.test(operation.openSnapshotHash ?? "") ||
    operation.openSnapshotHash !== deployOpenSnapshotHash(target) ||
    !Number.isInteger(target.version)
  )
    return false;

  const startedMs = Date.parse(operation.startedAt);
  const markerMs = operation.startUncertain ? Date.parse(operation.startUncertain.at) : undefined;
  const ageMs = nowMs - startedMs;
  return (
    Number.isFinite(startedMs) &&
    (markerMs === undefined || Number.isFinite(markerMs)) &&
    ageMs >= 0 &&
    ageMs <= 5 * 60_000
  );
}

async function openDeploySessionWithRecovery(target, req) {
  try {
    return await openDeploySession(target, req);
  } catch (error) {
    if (!(error instanceof Rejected) || error.code !== "locked") throw error;

    const hasSpec = target.spec !== undefined;
    const hasObserved = target.observed !== undefined;
    if (hasSpec !== hasObserved) throw error;

    if (hasObserved) {
      const operation = target.observed?.operation;
      if (!operation) throw error;

      // 只有"同一个请求"的 no-build session 可在 5min token 窗口内重发(startUncertain 只是诊断 marker)。
      if (resumableUnattachedStart(target, req)) {
        return {
          epoch: operation.lockEpoch,
          plan: {
            ifAbsent: false,
            fromPhase: target.observed.phase,
            expectedVersion: target.version,
            nextVersion: target.version,
            post: { spec: target.spec, observed: target.observed },
            projection: { status: target.status, ready: target.ready, components: target.components },
          },
          sessionTarget: target,
          sessionVersion: target.version,
        };
      }

      const status = operation.buildId ? await readExactBuildStatus(operation.buildId) : "UNKNOWN";
      if (status === "SUCCEEDED") {
        throw new Rejected(`现代 operation ${operation.operationId} 已成功,必须走 finalize/probe,禁止 takeover`, "needs-finalize");
      }
      if (isTerminalBuildStatus(status)) {
        throw new Rejected(`现代 operation ${operation.operationId} 已终止(${status}),必须走 failure reconciler`, "needs-failure-reconcile");
      }
      throw error; // IN_PROGRESS/UNKNOWN 均保持 locked。
    }

    const candidate = staleLockCandidate(target);
    if (!candidate) throw error;
    const status = await readExactBuildStatus(candidate.buildId);
    if (status === "SUCCEEDED") {
      throw new Rejected(`legacy holder ${candidate.prevOperationId} 的 build 已成功,必须走 finalize/fresh-probe 收养`, "needs-legacy-finalize");
    }
    if (isTerminalBuildStatus(status)) {
      // CodeBuild 终止不证明 CFN 已稳定/回滚;普通 broker 没有清锁权限(恢复端点 §19.8,Step 4)。
      throw new Rejected(`legacy holder ${candidate.prevOperationId} 已终止(${status}),必须走 CFN-aware failure recovery`, "needs-failure-reconcile");
    }
    throw error; // IN_PROGRESS/UNKNOWN 继续 locked。
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// StartBuild(带幂等 token)+ attach buildId(exact fence)(§19.4/19.5)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 启动 build。
 * 🔴 **只传 broker 自己构造的 `environmentVariablesOverride`**,值全部来自"入参白名单 + 注册表"。
 *    绝不传 buildspecOverride / imageOverride / serviceRoleOverride / sourceLocationOverride /
 *    sourceTypeOverride / sourceVersion / privilegedModeOverride / computeTypeOverride /
 *    environmentTypeOverride —— 那些正是 IR-P0-05 的攻击向量。
 * 🔴 幂等 token = sha256(target:op:epoch):SDK 注释明确**只在 5 分钟内有效**,仅覆盖短崩溃窗口;
 *    token 含 epoch —— 同 opId 新 epoch 复用 token 可能拿旧 build 或因参数漂移被 CodeBuild 拒。
 */
/**
 * 🔴 P0-E:预演能不能跑(只读判定)。有在途 operation 或残留顶层锁 ⇒ 不许预演。
 * 理由见 handler 处注释:预演会在同一批栈上建 change set,与在途部署互撞。
 */
function previewBlockedReason(target) {
  if (target?.observed?.operation) {
    return `该目标有在途部署会话(${target.observed.operation.operationId})—— 预演会与它在同一批栈上撞,先等它收口`;
  }
  if (
    target?.deployLockToken !== undefined ||
    target?.deployLockOperationId !== undefined ||
    target?.deployLockExpiresAt !== undefined
  ) {
    return `该目标有残留部署锁(${target.deployLockOperationId ?? "?"})—— 先走恢复端点收口再预演`;
  }
  return null;
}

async function startBuild(target, req, epoch, finalSnapshotName = "") {
  // 🔴 preview 不占 epoch(没开会话)⇒ 幂等 token 用固定后缀,避免与真部署的 token 撞。
  const tokenSeed = epoch === undefined ? `${target.targetId}:${req.operationId}:preview` : `${target.targetId}:${req.operationId}:${epoch}`;
  const idempotencyToken = createHash("sha256").update(tokenSeed).digest("hex");
  const out = await cb.send(
    new StartBuildCommand({
      projectName: PROJECT,
      idempotencyToken,
      environmentVariablesOverride: [
        { name: "EXEC_ENV_TARGET", value: target.targetId, type: "PLAINTEXT" },
        { name: "EXEC_ENV_REGION", value: target.region, type: "PLAINTEXT" },
        { name: "EXEC_ENV_ACCOUNT", value: target.accountId, type: "PLAINTEXT" },
        { name: "EXEC_ENV_COMPONENTS", value: req.components.join(","), type: "PLAINTEXT" },
        // @kf-batch 50-WP23-xregion-peering:VPC 地址段**只从描述符读**(注册时分配,不接客户端入参);
        //   home 可以为空 —— 栈组对 home 沿用存量段(见 infra/lib/exec-env/vpc-cidr.ts 的 HOME_EXEC_ENV_VPC_CIDR)。
        { name: "EXEC_ENV_VPC_CIDR", value: target.vpcCidr ?? "", type: "PLAINTEXT" },
        { name: "EXEC_ENV_OPERATION_ID", value: req.operationId, type: "PLAINTEXT" },
        { name: "EXEC_ENV_LOCK_EPOCH", value: String(epoch ?? ""), type: "PLAINTEXT" },
        // 🔴 P0-E(SPEC §3.5c):模式与审批指纹透传给 build 侧的**最后一关** `scripts/p0e-gate.mjs`。
        //    ① `EXEC_ENV_MODE=preview` ⇒ 只出裁决不部署;
        //    ② `EXEC_ENV_APPROVED_PLAN_HASH` ⇒ 闸拿它与**本地重算**的 planHash 逐字节比对,不匹配即 build 失败。
        //    这里只是**透传**:broker 不判断计划内容(它没有 synth 能力),判定权在闸里(不信上游结论)。
        // @kf-batch 50-WP15-airflow-serverless(K-5):NAT 数量只从注册表 networkProfile 派生(默认 standard=2,与旧行为逐字节相同)
        { name: "EXEC_ENV_MODE", value: req.mode ?? "deploy", type: "PLAINTEXT" },
        { name: "EXEC_ENV_APPROVED_PLAN_HASH", value: req.approvedPlanHash ?? "", type: "PLAINTEXT" },
        // 🔴 P0-E ④(SPEC §3.5c v3.6 订正:漂移可见 + 显式波次,**不重放旧源**)。
        //    两个值**只从注册表描述符读**,绝不接客户端入参(validate.mjs 的白名单里没有它们,加也不许):
        //    · `observed.baselineRef`        = 上次**成功**部署所用的源包哈希("现实装的是哪一份源");
        //    · `spec.desiredTemplateVersion` = 管理员**显式波次授权**升到哪一份源。
        //    闸拿它们与项目级 `EXEC_ENV_SOURCE_REF`(CDK 部署时锁定的本次源包哈希)比:
        //    相等 ⇒ 源零漂移、既有栈天然 no-op;不等且无波次授权 ⇒ requiresApproval;缺 baselineRef ⇒
        //    disruptive 但**不**要审批(否则全新 env 首装被自己挡死)。
        //    🔴 broker 仍只**透传**不判断(判定属共享判据,两侧同源由 parity 门禁钉住)。
        { name: "EXEC_ENV_BASELINE_REF", value: target?.observed?.baselineRef ?? "", type: "PLAINTEXT" },
        {
          name: "EXEC_ENV_DESIRED_TEMPLATE_VERSION",
          value: target?.spec?.desiredTemplateVersion ?? "",
          type: "PLAINTEXT",
        },
        // @kf-batch 50-WP30-decommission:最终快照名**只从注册表的删除计划读**(planDestroyOpen 校验过形态);
        //   非 destroy 模式恒为空串。重试销毁复用同一个名字 ⇒ build 侧据「快照已存在」跳过创建,绝不重复删/建。
        { name: "EXEC_ENV_FINAL_SNAPSHOT", value: finalSnapshotName, type: "PLAINTEXT" },
      ],
    })
  );
  if (!out.build?.id) throw new Error("StartBuild 成功响应缺 build.id");
  return out.build;
}

/**
 * attach buildId:条件绑 exact op/epoch/openSnapshotHash/startedAt + `attribute_not_exists(buildId)`
 * (旧 operation 附不到新会话;同 operation 已附不同 buildId 拒绝覆盖)。§19.5
 */
async function attachBuildId(targetId, operationId, epoch, plan, expectedVersion, buildId, retried = false) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: PK, sk: targetId },
        UpdateExpression:
          "SET #o.#operation.#buildId = :buildId, lastBuildId = :buildId, " +
          "lastOperationId = :operationId, #version = :nextVersion, updatedAt = :now " +
          "REMOVE #o.#operation.#startUncertain, #o.#operation.#attachUncertain",
        ConditionExpression:
          "#version = :openedVersion AND #lockEpoch = :epoch AND " +
          "deployLockToken = :operationId AND deployLockOperationId = :operationId AND " +
          "#o.#phase = :phase AND #sp.#desired = :desired AND " +
          "#o.#operation.#kind = :deploy AND " +
          "#o.#operation.#operationId = :operationId AND " +
          "#o.#operation.#operationEpoch = :epoch AND " +
          "#o.#operation.#openSnapshotHash = :openSnapshotHash AND " +
          "#o.#operation.#startedAt = :startedAt AND " +
          "attribute_not_exists(#o.#operation.#buildId)",
        ExpressionAttributeNames: {
          "#o": "observed",
          "#sp": "spec",
          "#phase": "phase",
          "#desired": "desiredComponents",
          "#operation": "operation",
          "#kind": "kind",
          "#operationId": "operationId",
          "#operationEpoch": "lockEpoch",
          "#openSnapshotHash": "openSnapshotHash",
          "#buildId": "buildId",
          "#startedAt": "startedAt",
          "#startUncertain": "startUncertain",
          "#attachUncertain": "attachUncertain",
          "#lockEpoch": "lockEpoch",
          "#version": "version",
        },
        ExpressionAttributeValues: {
          ":buildId": String(buildId),
          ":operationId": operationId,
          ":epoch": epoch,
          ":openSnapshotHash": plan.post.observed.operation.openSnapshotHash,
          ":phase": plan.post.observed.phase,
          ":desired": plan.post.spec.desiredComponents,
          ":deploy": "deploy",
          ":startedAt": plan.post.observed.operation.startedAt,
          ":openedVersion": expectedVersion,
          ":nextVersion": expectedVersion + 1,
          ":now": new Date().toISOString(),
        },
      })
    );
    return null;
  } catch (error) {
    // Update 响应也可能丢失:强一致读回,同 session+同 buildId 才可视为幂等成功。
    const current = await readTargetRaw(targetId).catch(() => null);
    const operation = current?.observed?.operation;
    const sameSession =
      operation?.kind === "deploy" &&
      operation.operationId === operationId &&
      operation.lockEpoch === epoch &&
      operation.openSnapshotHash === plan.post.observed.operation.openSnapshotHash &&
      operation.startedAt === plan.post.observed.operation.startedAt &&
      current?.lockEpoch === epoch &&
      current?.deployLockToken === operationId &&
      current?.deployLockOperationId === operationId &&
      current?.observed?.phase === plan.post.observed.phase &&
      JSON.stringify(current?.spec?.desiredComponents) === JSON.stringify(plan.post.spec.desiredComponents);

    if (sameSession && operation.buildId === String(buildId)) return null;
    if (sameSession && operation.buildId && operation.buildId !== String(buildId)) {
      throw new Rejected(`同一 operation 已附不同 buildId:${operation.buildId},拒绝覆盖 ${buildId}`, "locked");
    }
    if (sameSession && operation.buildId === undefined && !retried && Number.isInteger(current.version)) {
      return attachBuildId(targetId, operationId, epoch, plan, current.version, buildId, true);
    }
    if (sameSession && operation.buildId === undefined && current && Number.isInteger(current.version)) {
      await recordAttachUncertain(current, operationId, epoch, plan, buildId, error).catch(() => {});
    }
    throw new Rejected(
      `build 已启动(${buildId})但 exact attach 未确认,operation 保持阻断:` + String(error?.message || error),
      "locked"
    );
  }
}

async function recordAttachUncertain(current, operationId, epoch, plan, buildId, cause) {
  const at = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: PK, sk: current.targetId },
      UpdateExpression: "SET #o.#operation.#attachUncertain = :marker, #version = :nextVersion, updatedAt = :now",
      ConditionExpression:
        "#version = :expectedVersion AND #lockEpoch = :epoch AND " +
        "deployLockToken = :operationId AND deployLockOperationId = :operationId AND " +
        "#o.#phase = :phase AND #sp.#desired = :desired AND " +
        "#o.#operation.#kind = :deploy AND " +
        "#o.#operation.#operationId = :operationId AND " +
        "#o.#operation.#operationEpoch = :epoch AND " +
        "#o.#operation.#openSnapshotHash = :openSnapshotHash AND " +
        "#o.#operation.#startedAt = :startedAt AND " +
        "attribute_not_exists(#o.#operation.#buildId)",
      ExpressionAttributeNames: {
        "#o": "observed",
        "#sp": "spec",
        "#phase": "phase",
        "#desired": "desiredComponents",
        "#operation": "operation",
        "#attachUncertain": "attachUncertain",
        "#kind": "kind",
        "#operationId": "operationId",
        "#operationEpoch": "lockEpoch",
        "#openSnapshotHash": "openSnapshotHash",
        "#buildId": "buildId",
        "#startedAt": "startedAt",
        "#version": "version",
        "#lockEpoch": "lockEpoch",
      },
      ExpressionAttributeValues: {
        ":marker": {
          at,
          candidateBuildId: String(buildId),
          message: `build 已返回但 attach 未确认:${String(cause?.message ?? cause).slice(0, 420)}`,
        },
        ":expectedVersion": current.version,
        ":nextVersion": current.version + 1,
        ":operationId": operationId,
        ":epoch": epoch,
        ":openSnapshotHash": plan.post.observed.operation.openSnapshotHash,
        ":phase": plan.post.observed.phase,
        ":desired": plan.post.spec.desiredComponents,
        ":deploy": "deploy",
        ":startedAt": plan.post.observed.operation.startedAt,
        ":now": at,
      },
    })
  );
}

/**
 * StartBuild 抛错默认视为"结果不确定",不得自动清锁(§19.6)。写到当前 `operation.startUncertain`,
 * 保持 disruptive 阻断。**不写 `observed.lastError`**:在 provisioning 上它会把权威投影改成 `failed`,
 * 且只改 observed 不改顶层 status 会制造 strict projection mismatch;"结果未知"≠"部署失败"。
 */
async function recordStartUncertainFailure(targetId, operationId, epoch, plan, expectedVersion, error) {
  const at = new Date().toISOString();
  const observed = {
    ...plan.post.observed,
    operation: {
      ...plan.post.observed.operation,
      startUncertain: {
        at,
        message: `StartBuild 结果不确定,禁止自动清锁:` + String(error?.message || error).slice(0, 440),
      },
    },
  };

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: PK, sk: targetId },
      UpdateExpression: "SET #o = :observed, #version = :nextVersion, updatedAt = :now",
      ConditionExpression:
        "#version = :openedVersion AND #lockEpoch = :epoch AND " +
        "deployLockToken = :operationId AND deployLockOperationId = :operationId AND " +
        "#o.#phase = :phase AND #sp.#desired = :desired AND " +
        "#o.#operation.#kind = :deploy AND " +
        "#o.#operation.#operationId = :operationId AND " +
        "#o.#operation.#operationEpoch = :epoch AND " +
        "#o.#operation.#openSnapshotHash = :openSnapshotHash AND " +
        "#o.#operation.#startedAt = :startedAt AND " +
        "attribute_not_exists(#o.#operation.#buildId)",
      ExpressionAttributeNames: {
        "#o": "observed",
        "#sp": "spec",
        "#phase": "phase",
        "#desired": "desiredComponents",
        "#operation": "operation",
        "#kind": "kind",
        "#operationId": "operationId",
        "#operationEpoch": "lockEpoch",
        "#openSnapshotHash": "openSnapshotHash",
        "#buildId": "buildId",
        "#startedAt": "startedAt",
        "#version": "version",
        "#lockEpoch": "lockEpoch",
      },
      ExpressionAttributeValues: {
        ":observed": observed,
        ":openedVersion": expectedVersion,
        ":nextVersion": expectedVersion + 1,
        ":operationId": operationId,
        ":epoch": epoch,
        ":openSnapshotHash": plan.post.observed.operation.openSnapshotHash,
        ":phase": plan.post.observed.phase,
        ":desired": plan.post.spec.desiredComponents,
        ":deploy": "deploy",
        ":startedAt": plan.post.observed.operation.startedAt,
        ":now": at,
      },
    })
  );
}

/** 审计里只留 target 的非敏感识别字段。 */
function pickTarget(target) {
  return { targetId: target.targetId, region: target.region, accountId: target.accountId, status: target.status };
}

/**
 * 审计:入参 + 目标 + epoch + buildId 全留痕(§12.0「全程 audit」)。失败不阻断主流程但要留 log。
 * 🔴 排序键属性名是 **`ts`** —— `bgp-audit` 表的键是 `{pk, ts}`(infra/lib/database-stack.ts:37)。
 *    pk 分片形态 `audit#<targetId>#<day>`(SPEC §1.3 的审计分片合同)。
 */
async function audit(rec) {
  const line = JSON.stringify({ kind: "exec-env-deploy-broker", at: new Date().toISOString(), ...rec });
  console.log(line); // CloudWatch 兜底,保证即使审计表写失败也有痕
  if (!AUDIT_TABLE) return;
  const day = new Date().toISOString().slice(0, 10);
  await ddb.send(
    new UpdateCommand({
      TableName: AUDIT_TABLE,
      Key: { pk: `audit#${rec.req?.targetId ?? rec.target?.targetId ?? "unknown"}#${day}`, ts: `${Date.now()}#broker` },
      UpdateExpression: "SET payload = :p",
      ExpressionAttributeValues: { ":p": line },
    })
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-WP30-decommission —— 下线销毁(WP-30 路 B):开销毁会话 → StartBuild(mode=destroy)→ attach buildId
//   与部署同一把锁、同一个 epoch 序列、同一个写序(operation 先于 StartBuild 落库)。
//   🔴 broker **不清锁**:销毁会话的收口(→ gone / 卡住 → decommissioning + lastError)由平台观测到真值后,
//      在 lifecycle.ts 的唯一收口通道里带 fence 条件写完成(与部署成功 / 失败恢复同一纪律)。
// ══════════════════════════════════════════════════════════════════════════════

async function handleDestroy(req, target) {
  const { epoch, plan, sessionTarget, sessionVersion } = await openDestroySession(target, req);
  let build;
  try {
    build = await startBuild(sessionTarget, { ...req, components: plan.components }, epoch, plan.finalSnapshotName);
  } catch (error) {
    // 🔴 与部署同理:SDK 抛错 ≠ 服务端没受理 ⇒ 记 startUncertain、不清 operation/锁
    await recordDestroyStartUncertain(sessionTarget.targetId, req.operationId, epoch, plan, sessionVersion, error).catch((recordError) => {
      console.log(JSON.stringify({ kind: "exec-env-deploy-broker", at: new Date().toISOString(), recordDestroyStartFailed: String(recordError?.message || recordError) }));
    });
    throw error;
  }
  const warning = await attachDestroyBuildId(sessionTarget.targetId, req.operationId, epoch, plan, sessionVersion, build.id);
  await audit({ ok: true, req, target: pickTarget(sessionTarget), epoch, buildId: build.id, warning, mode: "destroy", approvalId: plan.approvalId, finalSnapshotName: plan.finalSnapshotName });
  return {
    ok: true,
    buildId: build.id,
    lockEpoch: epoch,
    targetId: sessionTarget.targetId,
    region: sessionTarget.region,
    mode: "destroy",
    ...(warning ? { warning } : {}),
  };
}

function matchesOpenedDestroySession(current, req, epoch, plan) {
  const operation = current?.observed?.operation;
  return (
    current?.targetId === req.targetId &&
    current?.version === plan.nextVersion &&
    current?.lockEpoch === epoch &&
    current?.deployLockToken === req.operationId &&
    current?.deployLockOperationId === req.operationId &&
    current?.deployLockExpiresAt === Date.parse(plan.post.observed.operation.startedAt) + LOCK_LEASE_MS &&
    operation?.kind === "destroy" &&
    operation.operationId === req.operationId &&
    operation.lockEpoch === epoch &&
    operation.startedAt === plan.post.observed.operation.startedAt &&
    operation.buildId === undefined &&
    current?.observed?.phase === "decommissioning" &&
    canonicalSessionJson(current.spec) === canonicalSessionJson(plan.post.spec) &&
    canonicalSessionJson(current.observed) === canonicalSessionJson(plan.post.observed) &&
    current.status === plan.projection.status &&
    current.ready === plan.projection.ready
  );
}

export function buildOpenDestroySessionUpdate(target, req, epoch, nowIso) {
  const oldEpoch = target.lockEpoch;
  if (oldEpoch !== undefined && !Number.isInteger(oldEpoch)) {
    throw new Rejected(`注册表 lockEpoch 非整数:${String(oldEpoch)}`, "bad-descriptor");
  }
  if (epoch !== Number(oldEpoch ?? 0) + 1) {
    throw new Rejected("open epoch 与 target pre-image 不连续", "bad-descriptor");
  }
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== nowIso) {
    throw new Rejected("nowIso 必须是 canonical ISO", "bad-descriptor");
  }
  const plan = planDestroyOpen(target, req, epoch, nowIso, SOURCE_REF);
  const names = {
    "#o": "observed",
    "#sp": "spec",
    "#status": "status",
    "#ready": "ready",
    "#components": "components",
    "#region": "region",
    "#accountId": "accountId",
    "#partition": "partition",
    "#version": "version",
    "#lockEpoch": "lockEpoch",
    "#dc": "decommission",
    "#dcApproval": "approvalId",
    "#dcSnapshot": "finalSnapshotName",
  };
  const values = {
    ":obs": plan.post.observed,
    ":status": plan.projection.status,
    ":ready": plan.projection.ready,
    ":components": plan.projection.components,
    ":currentTopComponents": target.components,
    ":expectedRegion": target.region,
    ":expectedAccountId": target.accountId,
    ":expectedPartition": target.partition,
    ":expectedVersion": plan.expectedVersion,
    ":nextVersion": plan.nextVersion,
    ":epoch": epoch,
    ":token": req.operationId,
    ":expires": now + LOCK_LEASE_MS,
    ":operationId": req.operationId,
    ":nowIso": nowIso,
    ":currentObserved": target.observed,
    ":currentSpec": target.spec,
    ":approvalId": plan.approvalId,
    ":finalSnapshot": plan.finalSnapshotName,
  };
  const epochCondition = oldEpoch === undefined ? "attribute_not_exists(#lockEpoch)" : "#lockEpoch = :oldEpoch";
  if (oldEpoch !== undefined) values[":oldEpoch"] = oldEpoch;
  const command = new UpdateCommand({
    TableName: TABLE,
    Key: { pk: PK, sk: target.targetId },
    // 🔴 spec **不写**(intent=delete 已由平台在审批通过时写定;broker 只开 observed 会话 + 锁)
    UpdateExpression:
      "SET deployLockToken = :token, deployLockExpiresAt = :expires, " +
      "deployLockOperationId = :operationId, #lockEpoch = :epoch, " +
      "#o = :obs, #status = :status, #ready = :ready, " +
      "#components = :components, #version = :nextVersion, updatedAt = :nowIso",
    ConditionExpression:
      "attribute_exists(sk) AND attribute_not_exists(deployLockToken) AND " +
      "attribute_not_exists(deployLockExpiresAt) AND attribute_not_exists(deployLockOperationId) AND " +
      "#version = :expectedVersion AND #region = :expectedRegion AND " +
      "#accountId = :expectedAccountId AND #partition = :expectedPartition AND " +
      "#components = :currentTopComponents AND " +
      epochCondition +
      " AND #o = :currentObserved AND #sp = :currentSpec AND " +
      // 删除计划也绑进条件:规划读到的那份审批 / 快照名,就是写入时库里的那份
      "#dc.#dcApproval = :approvalId AND #dc.#dcSnapshot = :finalSnapshot",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  });
  return { plan, command };
}

async function openDestroySession(target, req) {
  const oldEpoch = target.lockEpoch;
  if (oldEpoch !== undefined && !Number.isInteger(oldEpoch)) {
    throw new Rejected(`注册表 lockEpoch 非整数:${String(oldEpoch)}`, "bad-descriptor");
  }
  const epoch = Number(oldEpoch ?? 0) + 1;
  const nowIso = new Date().toISOString();
  const { plan, command } = buildOpenDestroySessionUpdate(target, req, epoch, nowIso);
  let opened;
  try {
    opened = await ddb.send(command);
  } catch (error) {
    const current = await readTargetRaw(target.targetId).catch(() => null);
    if (matchesOpenedDestroySession(current, req, epoch, plan)) {
      return { epoch, plan, sessionTarget: current, sessionVersion: plan.nextVersion };
    }
    const rejected = translateLockError(error, target);
    if (rejected) throw rejected;
    throw error;
  }
  const sessionTarget = opened?.Attributes ?? (await readTargetRaw(target.targetId).catch(() => null));
  if (!matchesOpenedDestroySession(sessionTarget, req, epoch, plan)) {
    throw new Rejected("destroy open Update 成功但无法取得 exact post-image;保留 operation 并停止 StartBuild", "locked");
  }
  return { epoch, plan, sessionTarget, sessionVersion: plan.nextVersion };
}

/** 销毁会话 attach / startUncertain 共用的 exact fence(旧 operation 附不到新会话)。 */
function destroySessionFence(operationId, epoch, plan, expectedVersion) {
  return {
    condition:
      "#version = :openedVersion AND #lockEpoch = :epoch AND " +
      "deployLockToken = :operationId AND deployLockOperationId = :operationId AND " +
      "#o.#phase = :phase AND #o.#operation.#kind = :destroy AND " +
      "#o.#operation.#operationId = :operationId AND " +
      "#o.#operation.#operationEpoch = :epoch AND " +
      "#o.#operation.#startedAt = :startedAt AND " +
      "attribute_not_exists(#o.#operation.#buildId)",
    names: {
      "#o": "observed",
      "#phase": "phase",
      "#operation": "operation",
      "#kind": "kind",
      "#operationId": "operationId",
      "#operationEpoch": "lockEpoch",
      "#buildId": "buildId",
      "#startedAt": "startedAt",
      "#lockEpoch": "lockEpoch",
      "#version": "version",
    },
    values: {
      ":operationId": operationId,
      ":epoch": epoch,
      ":phase": "decommissioning",
      ":destroy": "destroy",
      ":startedAt": plan.post.observed.operation.startedAt,
      ":openedVersion": expectedVersion,
      ":nextVersion": expectedVersion + 1,
    },
  };
}

async function attachDestroyBuildId(targetId, operationId, epoch, plan, expectedVersion, buildId) {
  const f = destroySessionFence(operationId, epoch, plan, expectedVersion);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: PK, sk: targetId },
        UpdateExpression:
          "SET #o.#operation.#buildId = :buildId, lastBuildId = :buildId, " +
          "lastOperationId = :operationId, #version = :nextVersion, updatedAt = :now",
        ConditionExpression: f.condition,
        ExpressionAttributeNames: f.names,
        ExpressionAttributeValues: { ...f.values, ":buildId": String(buildId), ":now": new Date().toISOString() },
      })
    );
    return null;
  } catch (error) {
    const current = await readTargetRaw(targetId).catch(() => null);
    const operation = current?.observed?.operation;
    if (operation?.kind === "destroy" && operation.operationId === operationId && operation.lockEpoch === epoch && operation.buildId === String(buildId)) {
      return null; // 同 session 同 buildId:幂等成功
    }
    // 🔴 不重试、不清锁:operation 保持阻断,平台观测侧按「无 buildId」走 startUncertain 收口窗(与部署同一条路)
    throw new Rejected(`销毁 build 已启动(${buildId})但 exact attach 未确认,operation 保持阻断:` + String(error?.message || error), "locked");
  }
}

async function recordDestroyStartUncertain(targetId, operationId, epoch, plan, expectedVersion, error) {
  const f = destroySessionFence(operationId, epoch, plan, expectedVersion);
  const at = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: PK, sk: targetId },
      UpdateExpression: "SET #o.#operation.#startUncertain = :marker, #version = :nextVersion, updatedAt = :now",
      ConditionExpression: f.condition,
      ExpressionAttributeNames: { ...f.names, "#startUncertain": "startUncertain" },
      ExpressionAttributeValues: {
        ...f.values,
        ":marker": { at, message: `StartBuild(destroy)结果不确定,禁止自动清锁:` + String(error?.message || error).slice(0, 420) },
        ":now": at,
      },
    })
  );
}
