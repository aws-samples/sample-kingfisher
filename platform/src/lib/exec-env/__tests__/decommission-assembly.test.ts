// @kf-batch 50-WP30-decommission
// 🔴🔴 WP-30 路 B「下线销毁」装配层:decommission ↔ delete-impact ↔ lifecycle(唯一写通道)↔ registry(准入内核)
//   ↔ deploy-control(broker / CodeBuild / 构建日志)↔ project-service(审批单)之间**一律不 mock**;
//   只 mock 真外部 —— DynamoDB(多表内存 + **忠实的条件表达式求值器** + 真分页)、Lambda(broker:用**真的** validate.mjs
//   规划开会话再落库,钉平台写的删除计划能被 broker 接住)、CodeBuild、CloudWatch Logs、CloudFormation、EC2、
//   Redshift Serverless、MWAA。
//
// 承重判据(WP-30 ⑤ 的离线半边):
//   ED-B1 drain 后绑定 / 落点 / 准入一律拒,拒因以「该执行环境已停止承接」开头(且 drain 之前是放行的 —— 正控制);
//   ED-B2 预览计数 == 夹具里逐行算出来的真值(多表、跨项目、真分页);有绑定 ⇒ 申请删除 409 并列明细;
//   ED-B3 申请 → 审批单带快照;指纹漂移 409;审批前再重算(漂移 ⇒ 拒批、零写);
//   施工序 4/5:broker 收到的只有 {targetId, operationId, mode};收口真查 AWS ⇒ gone / 卡住点名资源 + 真因;重试复用同一快照名;
//   ED-B5 删完同区能重新注册(一区一套不把 deleted 算占位)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

type Item = Record<string, any>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Item[]>,
  ddbCalls: [] as { name: string; table: string; input: any }[],
  /** Scan 的页大小(真 DDB 的 Limit / 1MiB 是**过滤之前**的量;夹具用小页逼出翻页) */
  scanPage: 3,
  lambda: [] as any[],
  /** broker 替身:收到 destroy 时怎么做(缺省 = 用真 validate.mjs 规划并落库) */
  brokerMode: "plan" as "plan" | "reject",
  buildStatus: "IN_PROGRESS" as string,
  logLines: [] as string[],
  stacks: {} as Record<string, string>,
  stackEvents: {} as Record<string, any[]>,
  vpcs: [] as string[],
  ec2Denied: false,
  rs: { workgroups: {} as Record<string, string>, namespaces: {} as Record<string, string>, snapshots: {} as Record<string, string> },
  mwaa: {} as Record<string, string>,
  validate: null as any,
}));

// ── 忠实的 DynamoDB 表达式求值器(与 discard-assembly 同款;只覆盖本链路真实发出的语法,认不出就抛)──────────────
function resolvePath(item: Item, path: string, names: Record<string, string>): { found: boolean; value?: unknown } {
  let cur: any = item;
  for (const seg of path.trim().split(".")) {
    const key = seg.startsWith("#") ? names[seg] : seg;
    if (key === undefined) throw new Error(`ValidationException: 未定义的名字 ${seg}`);
    if (cur === null || typeof cur !== "object" || !(key in cur)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
}
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${k}:${canon((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function splitTop(expr: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, buf = "";
  for (const t of expr.split(/(\(|\)|\s+)/)) {
    if (t === "(") depth++;
    if (t === ")") depth--;
    if (depth === 0 && t === sep) { out.push(buf); buf = ""; continue; }
    buf += t;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}
function evalCond(expr: string, item: Item, names: Record<string, string>, values: Record<string, unknown>, used: Set<string>): boolean {
  const s = expr.trim();
  const ands = splitTop(s, "AND");
  if (ands.length > 1) return ands.map((a) => evalCond(a, item, names, values, used)).every(Boolean);
  const ors = splitTop(s, "OR");
  if (ors.length > 1) return ors.map((a) => evalCond(a, item, names, values, used)).some(Boolean);
  if (s.startsWith("(") && s.endsWith(")")) return evalCond(s.slice(1, -1), item, names, values, used);
  const fn = s.match(/^(attribute_exists|attribute_not_exists)\(([^)]+)\)$/);
  if (fn) {
    fn[2].split(".").forEach((p) => used.add(p.trim()));
    const r = resolvePath(item, fn[2], names);
    return fn[1] === "attribute_exists" ? r.found : !r.found;
  }
  const cmp = s.match(/^(\S+)\s*(=|<>)\s*(:\w+)$/);
  if (cmp) {
    cmp[1].split(".").forEach((p) => used.add(p));
    used.add(cmp[3]);
    if (!(cmp[3] in values)) throw new Error(`ValidationException: 未定义的值 ${cmp[3]}`);
    const r = resolvePath(item, cmp[1], names);
    const eq = r.found && canon(r.value) === canon(values[cmp[3]]);
    return cmp[2] === "=" ? eq : r.found && !eq;
  }
  throw new Error(`求值器不认识的条件片段(夹具要先扩充,别静默放行):${s}`);
}
function applyUpdate(item: Item, expr: string, names: Record<string, string>, values: Record<string, unknown>, used: Set<string>): Item {
  const next: Item = structuredClone(item);
  const m = expr.match(/^SET (.*?)(?: REMOVE (.*))?$/);
  if (!m) throw new Error(`求值器不认识的更新表达式:${expr}`);
  for (const a of m[1].split(",")) {
    const [lhs, rhs] = a.split("=").map((x) => x.trim());
    if (lhs.includes(".")) throw new Error(`本链路只应整属性 SET,却出现 ${lhs}`);
    const key = lhs.startsWith("#") ? names[lhs] : lhs;
    used.add(lhs); used.add(rhs);
    if (!(rhs in values)) throw new Error(`ValidationException: 未定义的值 ${rhs}`);
    next[key] = structuredClone(values[rhs]);
  }
  for (const r of (m[2] || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    used.add(r);
    delete next[r.startsWith("#") ? names[r] : r];
  }
  return next;
}
function hasUndefinedDeep(v: unknown): boolean {
  if (v === undefined) return true;
  if (Array.isArray(v)) return v.some(hasUndefinedDeep);
  if (v && typeof v === "object") return Object.values(v).some(hasUndefinedDeep);
  return false;
}
const KEY_ATTRS: Record<string, string[]> = { "bgp-execution-envs": ["pk", "sk"], "bgp-approvals": ["pk", "approvalId"] };
const keyOf = (table: string, obj: Item) => (KEY_ATTRS[table] ?? ["userId", "taskId"]).map((k) => String(obj[k])).join("|");
const rows = (table: string) => (h.tables[table] ??= []);
function findRow(table: string, key: Item): Item | undefined {
  return rows(table).find((r) => keyOf(table, r) === keyOf(table, key));
}

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    docClient: {
      send: async (cmd: any) => {
        const name = cmd.constructor.name;
        const table = cmd.input.TableName;
        h.ddbCalls.push({ name, table, input: structuredClone(cmd.input) });
        if (name === "GetCommand") {
          const r = findRow(table, cmd.input.Key);
          return { Item: r ? structuredClone(r) : undefined };
        }
        if (name === "PutCommand") {
          const item = cmd.input.Item;
          if (hasUndefinedDeep(item)) throw new Error("Pass options.removeUndefinedValues=true");
          const cur = findRow(table, item);
          if (cmd.input.ConditionExpression) {
            const used = new Set<string>();
            if (!evalCond(cmd.input.ConditionExpression, cur ?? {}, cmd.input.ExpressionAttributeNames ?? {}, cmd.input.ExpressionAttributeValues ?? {}, used)) {
              throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
            }
          }
          h.tables[table] = rows(table).filter((r) => keyOf(table, r) !== keyOf(table, item));
          rows(table).push(structuredClone(item));
          return {};
        }
        if (name === "UpdateCommand") {
          const { UpdateExpression, ConditionExpression, ExpressionAttributeNames: N = {}, ExpressionAttributeValues: V = {} } = cmd.input;
          if (hasUndefinedDeep(V)) throw new Error("Pass options.removeUndefinedValues=true");
          const cur = findRow(table, cmd.input.Key);
          const used = new Set<string>();
          const ok = !ConditionExpression || (cur !== undefined && evalCond(ConditionExpression, cur, N, V, used));
          const next = applyUpdate(cur ?? { ...cmd.input.Key }, UpdateExpression, N, V, used);
          const unused = [...Object.keys(N), ...Object.keys(V)].filter((k) => !used.has(k));
          if (unused.length) throw Object.assign(new Error(`ValidationException: unused ${unused.join(",")}`), { name: "ValidationException" });
          if (!ok) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
          h.tables[table] = rows(table).filter((r) => keyOf(table, r) !== keyOf(table, cmd.input.Key));
          rows(table).push(next);
          return cmd.input.ReturnValues === "ALL_NEW" ? { Attributes: structuredClone(next) } : {};
        }
        if (name === "QueryCommand") {
          const all = rows(table).filter((r) => evalCond(cmd.input.KeyConditionExpression, r, cmd.input.ExpressionAttributeNames ?? {}, cmd.input.ExpressionAttributeValues ?? {}, new Set()));
          return { Items: structuredClone(all) };
        }
        if (name === "ScanCommand") {
          const all = rows(table);
          const start = Number(cmd.input.ExclusiveStartKey?.__offset ?? 0);
          const page = all.slice(start, start + h.scanPage);
          const items = cmd.input.FilterExpression
            ? page.filter((r) => evalCond(cmd.input.FilterExpression, r, cmd.input.ExpressionAttributeNames ?? {}, cmd.input.ExpressionAttributeValues ?? {}, new Set()))
            : page;
          return { Items: structuredClone(items), ...(start + h.scanPage < all.length ? { LastEvaluatedKey: { __offset: start + h.scanPage } } : {}) };
        }
        throw new Error(`装配夹具未预期的 DDB 调用:${name}`);
      },
    },
  };
});

// ── broker 替身:**真的** validate.mjs 做规划(planDestroyOpen),再像 index.mjs 那样一次落库 + attach buildId ──
vi.mock("@aws-sdk/client-lambda", async (orig) => {
  const real: any = await orig();
  class FakeLambda {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      if (name !== "InvokeCommand") throw new Error(`装配夹具未预期的 Lambda 调用:${name}`);
      const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      h.lambda.push(payload);
      const respond = (o: unknown) => ({ Payload: Buffer.from(JSON.stringify(o)) });
      if (h.brokerMode === "reject") return respond({ ok: false, code: "locked", message: "部署锁被占" });
      const v = h.validate;
      try {
        const req = v.validateInput(payload);
        const item = findRow("bgp-execution-envs", { pk: "env", sk: req.targetId });
        const epoch = Number(item?.lockEpoch ?? 0) + 1;
        const now = new Date().toISOString();
        const plan = v.planDestroyOpen(item, req, epoch, now, "src-ref");
        const buildId = `bgp-exec-env-deploy:${req.operationId}`;
        const next = {
          ...item,
          observed: { ...plan.post.observed, operation: { ...plan.post.observed.operation, buildId } },
          status: plan.projection.status,
          ready: plan.projection.ready,
          components: plan.projection.components,
          version: plan.nextVersion + 1, // open + attach 两次写
          lockEpoch: epoch,
          deployLockToken: req.operationId,
          deployLockOperationId: req.operationId,
          deployLockExpiresAt: Date.parse(now) + 135 * 60_000,
          lastBuildId: buildId,
          lastOperationId: req.operationId,
        };
        h.tables["bgp-execution-envs"] = rows("bgp-execution-envs").filter((r) => r.sk !== req.targetId);
        rows("bgp-execution-envs").push(next);
        return respond({ ok: true, buildId, lockEpoch: epoch, targetId: req.targetId, region: item.region, mode: "destroy" });
      } catch (e: any) {
        return respond({ ok: false, code: e?.code ?? "error", message: String(e?.message ?? e) });
      }
    }
  }
  return { ...real, LambdaClient: FakeLambda };
});

vi.mock("@aws-sdk/client-codebuild", async (orig) => {
  const real: any = await orig();
  class FakeCb {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      if (name === "BatchGetBuildsCommand") return { builds: [{ id: cmd.input.ids[0], buildStatus: h.buildStatus, logs: { groupName: "/aws/codebuild/bgp-exec-env-deploy", streamName: "s1" } }] };
      if (name === "ListBuildsForProjectCommand") return { ids: [] };
      throw new Error(`装配夹具未预期的 CodeBuild 调用:${name}`);
    }
  }
  return { ...real, CodeBuildClient: FakeCb };
});
vi.mock("@aws-sdk/client-cloudwatch-logs", async (orig) => {
  const real: any = await orig();
  class FakeLogs {
    async send(cmd: any) {
      if (cmd.constructor.name === "GetLogEventsCommand") return { events: h.logLines.map((message) => ({ message })) };
      throw new Error(`装配夹具未预期的 Logs 调用:${cmd.constructor.name}`);
    }
  }
  return { ...real, CloudWatchLogsClient: FakeLogs };
});
vi.mock("@aws-sdk/client-cloudformation", async (orig) => {
  const real: any = await orig();
  class FakeCfn {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      const st = h.stacks[cmd.input.StackName];
      if (name === "DescribeStacksCommand") {
        if (!st) throw Object.assign(new Error(`Stack with id ${cmd.input.StackName} does not exist`), { name: "ValidationError" });
        return { Stacks: [{ StackName: cmd.input.StackName, StackStatus: st }] };
      }
      if (name === "DescribeStackEventsCommand") return { StackEvents: h.stackEvents[cmd.input.StackName] ?? [] };
      if (name === "ListChangeSetsCommand") return { Summaries: [] };
      throw new Error(`装配夹具未预期的 CFN 调用:${name}`);
    }
  }
  return { ...real, CloudFormationClient: FakeCfn };
});
vi.mock("@aws-sdk/client-ec2", async (orig) => {
  const real: any = await orig();
  class FakeEc2 {
    async send(cmd: any) {
      if (cmd.constructor.name !== "DescribeVpcsCommand") throw new Error(`装配夹具未预期的 EC2 调用:${cmd.constructor.name}`);
      if (h.ec2Denied) throw Object.assign(new Error("not authorized to perform ec2:DescribeVpcs"), { name: "UnauthorizedOperation" });
      return { Vpcs: h.vpcs.map((VpcId) => ({ VpcId })) };
    }
  }
  return { ...real, EC2Client: FakeEc2 };
});
vi.mock("@aws-sdk/client-redshift-serverless", async (orig) => {
  const real: any = await orig();
  const nf = () => Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
  class FakeRs {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      if (name === "GetWorkgroupCommand") { const s = h.rs.workgroups[cmd.input.workgroupName]; if (!s) throw nf(); return { workgroup: { status: s } }; }
      if (name === "GetNamespaceCommand") { const s = h.rs.namespaces[cmd.input.namespaceName]; if (!s) throw nf(); return { namespace: { status: s } }; }
      if (name === "GetSnapshotCommand") { const s = h.rs.snapshots[cmd.input.snapshotName]; if (!s) throw nf(); return { snapshot: { status: s } }; }
      throw new Error(`装配夹具未预期的 Redshift Serverless 调用:${name}`);
    }
  }
  return { ...real, RedshiftServerlessClient: FakeRs };
});
vi.mock("@aws-sdk/client-mwaa", async (orig) => {
  const real: any = await orig();
  class FakeMwaa {
    async send(cmd: any) {
      const s = h.mwaa[cmd.input.Name];
      if (!s) throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
      return { Environment: { Status: s } };
    }
  }
  return { ...real, MWAAClient: FakeMwaa };
});

import {
  previewDelete,
  requestDelete,
  preflightApprovedDelete,
  startApprovedDestroy,
  retryDestroy,
  observeDecommission,
  DecommissionRefused,
  EXEC_ENV_DELETE_APPROVAL_TYPE,
} from "../decommission";
import { IMPACT_SOURCES } from "../delete-impact";
import { setSpecIntent, settleDestroy, transitionPhase, PhaseTransitionError, FINAL_SNAPSHOT_RE, DESTROYABLE_PHASES } from "../lifecycle";
import { requireReadyTarget, TargetNotReadyError, registerTarget, TARGET_COMPONENTS } from "../registry";
import { assertBindableTarget } from "../data-plane-target";
import { targetNotReadyResponse } from "../target-http";
import { DESTROY_REPORT_MARKER } from "../deploy-control";
import { resolvePlace } from "@/lib/place/resolve";
import { PlaceUnavailable } from "@/lib/place/types";
import { decideApproval, getApproval } from "@/lib/projects/project-service";
import { BACKFILL_PLAN_BINDING_ATTR } from "@/lib/backfill/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const BROKER_VALIDATE = resolve(REPO, "infra/lambda/exec-env-broker/validate.mjs");
process.env.EXEC_ENV_COMPONENT_ENUM = TARGET_COMPONENTS.join(",");
process.env.EXEC_ENV_REQUIRED_COMPONENTS = "core,redshift,dms,flink,airflow-serverless";

const TID = "tgt_usw2_a";
const SLUG = "tgt-usw2-a";
const ACCOUNT = "123456789012";

function coreResources() {
  return {
    datalakeBucket: `bgp-datalake-${ACCOUNT}-${SLUG}`,
    scriptsBucket: `bgp-glue-scripts-${ACCOUNT}-${SLUG}`,
    tableBucket: `bgp-table-bucket-${SLUG}`,
    athenaWorkgroup: `bgp-athena-${SLUG}`,
    glueRoleArn: `arn:aws:iam::${ACCOUNT}:role/BgpExecEnv-${SLUG}-glue-role`,
    emrSecurityGroupId: "sg-0123456789abcdef0",
    emrSubnetIds: ["subnet-0123456789abcdef0", "subnet-abcdef0123456789"],
  };
}
/** 合法的 modern 非 home 描述符:默认**新鲜且可服务**(不可服务要显式制造) */
function readyTarget(over: Item = {}): Item {
  const at = new Date().toISOString();
  const probe = { at, ok: true, items: [{ name: "datalakeBucket", ok: true }] };
  return {
    pk: "env", sk: TID, targetId: TID, partition: "aws", accountId: ACCOUNT, region: "us-west-2", jurisdiction: "home",
    vpcCidr: "10.128.0.0/16", status: "active", ready: true, components: ["core"], resources: coreResources(), updatedAt: at, probe,
    spec: { intent: "serve", desiredComponents: ["core"] },
    observed: { phase: "ready", health: "healthy", components: ["core"], probe, lastReconcileAt: at },
    version: 5,
    ...over,
  };
}
const target = () => findRow("bgp-execution-envs", { pk: "env", sk: TID })!;
const put = (table: string, item: Item) => rows(table).push(item);
const ID = { approved: "" };

async function drain() {
  await setSpecIntent(TID, "drain", { expectedVersion: target().version });
}

beforeEach(async () => {
  h.tables = {};
  h.ddbCalls = [];
  h.lambda = [];
  h.brokerMode = "plan";
  h.buildStatus = "IN_PROGRESS";
  h.logLines = [];
  h.stacks = { [`BgpExecEnv-${SLUG}-base`]: "CREATE_COMPLETE", [`BgpExecEnv-${SLUG}-core`]: "CREATE_COMPLETE" };
  h.stackEvents = {};
  h.vpcs = ["vpc-0abc"];
  h.ec2Denied = false;
  h.rs = { workgroups: {}, namespaces: {}, snapshots: {} };
  h.mwaa = {};
  h.scanPage = 3;
  h.validate ??= await import(BROKER_VALIDATE);
  put("bgp-execution-envs", readyTarget());
});

describe("ED-B1 停止承接:drain 之后绑定 / 落点 / 准入一律拒,拒因说「该执行环境已停止承接」", () => {
  it("正控制:drain 之前三个入口都放行", async () => {
    await expect(requireReadyTarget(TID)).resolves.toMatchObject({ targetId: TID });
    await expect(assertBindableTarget(TID, "core", { scope: "platform-global" })).resolves.toBe(TID);
    await expect(resolvePlace({ kind: "target", targetId: TID } as never)).resolves.toMatchObject({ targetId: TID });
  });

  it("drain 之后:准入 409(target-http 单一映射)、绑定被拒、落点被拒 —— 三处同一句拒因", async () => {
    await drain();
    const e1 = await requireReadyTarget(TID).catch((e) => e);
    expect(e1).toBeInstanceOf(TargetNotReadyError);
    expect((e1 as TargetNotReadyError).why).toMatch(/^该执行环境已停止承接/);
    const resp = targetNotReadyResponse(e1)!;
    expect(resp.status).toBe(409);
    expect(JSON.stringify(await resp.json())).toContain("该执行环境已停止承接");
    await expect(assertBindableTarget(TID, "core", { scope: "platform-global" })).rejects.toThrow(/该执行环境已停止承接/);
    const e3 = await resolvePlace({ kind: "target", targetId: TID } as never).catch((e) => e);
    expect(e3).toBeInstanceOf(PlaceUnavailable);
    expect(String(e3.message)).toContain("该执行环境已停止承接");
  });
});

describe("ED-B2 影响预览:计数 == DDB 逐行真值(多表 / 跨项目 / 真分页),有绑定 ⇒ 不许申请", () => {
  function seedImpactRows() {
    put("bgp-sync-tasks", { userId: "default-user", taskId: "sync-1", name: "订单同步", projectId: "p1", targets: [TID], scheduleEnabled: true });
    put("bgp-sync-tasks", { userId: "default-user", taskId: "sync-2", name: "别区同步", projectId: "p1", targets: ["tgt_use2_a"] });
    put("bgp-sync-tasks", { userId: "default-user", taskId: "sync-3", name: "主控区同步", projectId: "p2" }); // 缺省 = home
    put("bgp-etl-jobs", { userId: "default-user", jobId: "etl-1", name: "日报", projectId: "p2", targetId: TID, scheduleEnabled: false }); // 单值章
    put("bgp-workflows", { userId: "default-user", workflowId: "wf-1", name: "两区编排", targets: ["tgt_home", TID], scheduleEnabled: true });
    put("bgp-datasources", { userId: "default-user", datasourceId: "ds-1", name: "订单库", ownerTargetId: TID });
    put("bgp-datasources", { userId: "default-user", datasourceId: "ds-2", name: "主控区库", ownerTargetId: "tgt_home" });
    put("bgp-backfill-plans", { pk: "backfill#p1", planId: "bf-1", name: "补数", [BACKFILL_PLAN_BINDING_ATTR]: [TID] });
    put("bgp-model-tables", { pk: "modeltable", modelTableId: "mt-1", name: "dim_user", targets: [TID] });
    put("bgp-action-schedules", { userId: "default-user", taskId: "gov_1", name: "定时质量检查", targets: [TID], scheduleEnabled: true });
    put("bgp-task-runs", { taskId: "sync-1", runId: "r1", status: "running", targetId: TID });
    put("bgp-task-runs", { taskId: "sync-1", runId: "r0", status: "succeeded", targetId: TID });
    put("bgp-task-runs", { taskId: "sync-2", runId: "r2", status: "running", targetId: "tgt_use2_a" });
  }
  /** 独立算真值(不经 delete-impact):按行读绑定字段 */
  function truth() {
    const binds = (r: Item, attr = "targets") => (Array.isArray(r[attr]) ? r[attr] : r.targetId ? [r.targetId] : ["tgt_home"]).includes(TID);
    const b = [
      ...rows("bgp-sync-tasks").filter((r) => binds(r)),
      ...rows("bgp-etl-jobs").filter((r) => binds(r)),
      ...rows("bgp-workflows").filter((r) => binds(r)),
      ...rows("bgp-datasources").filter((r) => r.ownerTargetId === TID),
      ...rows("bgp-backfill-plans").filter((r) => binds(r, BACKFILL_PLAN_BINDING_ATTR)),
      ...rows("bgp-model-tables").filter((r) => binds(r)),
      ...rows("bgp-action-schedules").filter((r) => binds(r)),
    ];
    return {
      bindings: b.length,
      schedules: b.filter((r) => r.scheduleEnabled === true).length,
      runs: rows("bgp-task-runs").filter((r) => r.status === "running" && r.targetId === TID).length,
    };
  }

  it("计数逐项等于真值;明细能直达去解绑;没过 drain 之前就有 NOT_DRAINED 拒因", async () => {
    seedImpactRows();
    h.scanPage = 2;
    const p = await previewDelete(TID);
    const want = truth();
    expect(want).toEqual({ bindings: 7, schedules: 3, runs: 1 }); // 夹具自检:真值本身是我们以为的那样
    expect(p.impact.counts).toEqual({ bindings: want.bindings, schedules: want.schedules, runningRuns: want.runs });
    expect(p.impact.bindings.map((b) => `${b.kind}/${b.id}`).sort()).toEqual(
      ["action-schedule/gov_1", "backfill-plan/bf-1", "datasource/ds-1", "etl-job/etl-1", "model-table/mt-1", "sync/sync-1", "workflow/wf-1"]
    );
    expect(p.impact.runningRuns).toEqual([{ taskId: "sync-1", runId: "r1" }]);
    expect(p.impact.clear).toBe(false);
    expect(p.stage).toBe("serving");
    expect(p.blockers.join(";")).toMatch(/先〔停止承接〕/);
    // 真分页:页大小 3 ⇒ 至少一张表翻了页(否则这条判据看不出「只读第一页」那种少报)
    expect(h.ddbCalls.filter((c) => c.name === "ScanCommand" && c.input.ExclusiveStartKey).length).toBeGreaterThan(0);
  });

  it("drain 后有绑定 ⇒ 申请删除 409 IMPACT_NOT_ZERO 并带明细;读不到的来源 ⇒ IMPACT_UNVERIFIABLE(读不到 ≠ 没有)", async () => {
    seedImpactRows();
    await drain();
    const p = await previewDelete(TID);
    const e = await requestDelete(TID, { confirm: "us-west-2", previewHash: p.impact.previewHash }, { username: "admin" }).catch((x) => x);
    expect(e).toBeInstanceOf(DecommissionRefused);
    expect(e.code).toBe("IMPACT_NOT_ZERO");
    expect(e.httpStatus).toBe(409);
    expect((e.detail as any).impact.bindings.length).toBe(7);
    // 读不到:让 bgp-flink-jobs 的 Scan 抛
    rows("bgp-sync-tasks").length = 0; rows("bgp-etl-jobs").length = 0; rows("bgp-workflows").length = 0; rows("bgp-datasources").length = 0;
    rows("bgp-backfill-plans").length = 0; rows("bgp-model-tables").length = 0; rows("bgp-action-schedules").length = 0; rows("bgp-task-runs").length = 0;
    Object.defineProperty(h.tables, "bgp-flink-jobs", { get: () => { throw new Error("AccessDeniedException: arn:aws:iam::123456789012:role/x"); }, configurable: true });
    const p2 = await previewDelete(TID);
    delete (h.tables as any)["bgp-flink-jobs"];
    expect(p2.impact.counts.bindings).toBeNull();
    expect(p2.impact.unresolved.map((u) => u.source)).toEqual(["flink-job"]);
    expect(p2.impact.unresolved[0].error).not.toContain(ACCOUNT); // 账号号脱敏
    expect(p2.impact.clear).toBe(false);
  });

  it("来源清单覆盖每一类「绑在执行环境上」的定义(漏一类 = 那一类永远挡不住删除)", () => {
    expect(IMPACT_SOURCES.map((s) => s.kind).sort()).toEqual(
      ["action-schedule", "backfill-plan", "code-table", "datasource", "engine-job", "etl-job", "flink-job", "model-table", "redshift-task", "sync", "workflow"]
    );
  });
});

describe("ED-B3 申请 → 审批:强确认 / 指纹 / 快照 / 审批前重算", () => {
  it("home ⇒ 403;从没部署过 ⇒ USE_DISCARD;region 名不对 ⇒ 400;未 drain ⇒ NOT_DRAINED", async () => {
    put("bgp-execution-envs", { ...readyTarget(), sk: "tgt_home", targetId: "tgt_home", isHome: true });
    await expect(requestDelete("tgt_home", { confirm: "us-west-2", previewHash: "a".repeat(64) }, { username: "a" })).rejects.toMatchObject({ httpStatus: 403 });
    const p = await previewDelete(TID);
    await expect(requestDelete(TID, { confirm: "us-west-2", previewHash: p.impact.previewHash }, { username: "a" })).rejects.toMatchObject({ code: "NOT_DRAINED" });
    await drain();
    await expect(requestDelete(TID, { confirm: "us-west-1", previewHash: p.impact.previewHash }, { username: "a" })).rejects.toMatchObject({ httpStatus: 400 });
    const reg = readyTarget({ status: "registered", ready: false, spec: { intent: "drain", desiredComponents: ["core"] }, observed: { phase: "registered", health: "unknown", components: ["core"] } });
    h.tables["bgp-execution-envs"] = [reg];
    await expect(requestDelete(TID, { confirm: "us-west-2", previewHash: p.impact.previewHash }, { username: "a" })).rejects.toMatchObject({ code: "USE_DISCARD" });
  });

  it("与本区无关的写入不改指纹;清单本身变了(保留资源多了快照)⇒ 409 PREVIEW_DRIFT(带新清单);重新预览后能申请;审批单带快照;再申请 ⇒ DUPLICATE_REQUEST", async () => {
    await drain();
    const p = await previewDelete(TID);
    expect(p.impact.clear).toBe(true);
    // 预览之后、提交之前有人建了一个 home 的作业(不绑本区)⇒ 指纹不变,不算漂移
    put("bgp-etl-jobs", { userId: "default-user", jobId: "etl-home", name: "主控区作业" });
    // 再一个在别的视角里的运行记录(已结束)⇒ 也不算
    put("bgp-task-runs", { taskId: "x", runId: "1", status: "succeeded", targetId: TID });
    const pAgain = await previewDelete(TID);
    expect(pAgain.impact.previewHash).toBe(p.impact.previewHash);
    // 「计数为 0 但清单变了」的漂移:环境补装了 redshift ⇒ 将保留清单多了最终快照
    rows("bgp-execution-envs")[0].components = ["core", "redshift"];
    rows("bgp-execution-envs")[0].spec.desiredComponents = ["core", "redshift"];
    rows("bgp-execution-envs")[0].observed.components = ["core", "redshift"];
    const e = await requestDelete(TID, { confirm: "us-west-2", previewHash: p.impact.previewHash }, { username: "a" }).catch((x) => x);
    expect(e.code).toBe("PREVIEW_DRIFT");
    const fresh = (e.detail as any).impact;
    expect(fresh.retained.some((r: any) => r.kind === "redshift-snapshot")).toBe(true);
    const ok = await requestDelete(TID, { confirm: "us-west-2", previewHash: fresh.previewHash }, { username: "admin", sub: "sub-1" });
    expect(ok.approval.type).toBe(EXEC_ENV_DELETE_APPROVAL_TYPE);
    expect(ok.approval.status).toBe("pending");
    expect(ok.approval.targetIds).toEqual([TID]);
    expect(ok.approval.payload.previewHash).toBe(fresh.previewHash);
    expect((ok.approval.payload.snapshot as any).counts).toEqual({ bindings: 0, schedules: 0, runningRuns: 0 });
    expect((ok.approval.payload.snapshot as any).retained.map((r: any) => r.name)).toContain(`bgp-datalake-${ACCOUNT}-${SLUG}`);
    await expect(requestDelete(TID, { confirm: "us-west-2", previewHash: fresh.previewHash }, { username: "admin" })).rejects.toMatchObject({ code: "DUPLICATE_REQUEST" });
    expect((await previewDelete(TID)).stage).toBe("pending-approval");
  });

  it("审批期间影响清单变了 ⇒ 预检拒批(审批单仍 pending、注册表零写)", async () => {
    await drain();
    const p = await previewDelete(TID);
    const { approval } = await requestDelete(TID, { confirm: "us-west-2", previewHash: p.impact.previewHash }, { username: "dev-admin" });
    put("bgp-sync-tasks", { userId: "default-user", taskId: "late", name: "审批期间绑上的", targets: [TID] });
    const before = structuredClone(target());
    await expect(preflightApprovedDelete(approval)).rejects.toMatchObject({ code: "IMPACT_NOT_ZERO" });
    expect(target()).toEqual(before);
    expect((await getApproval(approval.approvalId))!.status).toBe("pending");
  });

  it("审批期间三个数仍是 0、但清单变了(补装了数仓 ⇒ 保留清单多了最终快照)⇒ 预检 PREVIEW_DRIFT 拒批,零写", async () => {
    await drain();
    const p = await previewDelete(TID);
    const { approval } = await requestDelete(TID, { confirm: "us-west-2", previewHash: p.impact.previewHash }, { username: "dev-admin" });
    const t = target();
    t.components = ["core", "redshift"]; t.spec.desiredComponents = ["core", "redshift"]; t.observed.components = ["core", "redshift"];
    const before = structuredClone(target());
    const e = await preflightApprovedDelete(approval).catch((x) => x);
    expect(e).toBeInstanceOf(DecommissionRefused);
    expect(e.code).toBe("PREVIEW_DRIFT");
    expect((e.detail as any).impact.counts).toEqual({ bindings: 0, schedules: 0, runningRuns: 0 });
    expect(target()).toEqual(before);
  });
});

/** 走完 drain → 申请 → 批准,返回批准后的审批单 */
async function approveDeletion(components: string[] = ["core", "redshift"]) {
  const t0 = target();
  t0.components = components; t0.spec.desiredComponents = components; t0.observed.components = components;
  await drain();
  const p = await previewDelete(TID);
  const { approval } = await requestDelete(TID, { confirm: "us-west-2", previewHash: p.impact.previewHash }, { username: "dev-admin" });
  await preflightApprovedDelete(approval);
  const decided = await decideApproval(approval.approvalId, "approved", "platform-admin");
  ID.approved = approval.approvalId;
  return decided!;
}

describe("施工序 3/4:审批通过 ⇒ 删除计划落库 ⇒ broker(真 validate.mjs)接得住", () => {
  it("broker 只收到 {targetId, operationId, mode:destroy};注册表进 decommissioning + destroy 会话 + 锁;计划里的快照名合法", async () => {
    const decided = await approveDeletion();
    const r = await startApprovedDestroy(decided, { username: "platform-admin" });
    expect(h.lambda).toHaveLength(1);
    expect(Object.keys(h.lambda[0]).sort()).toEqual(["mode", "operationId", "targetId"]);
    expect(h.lambda[0]).toMatchObject({ targetId: TID, mode: "destroy" });
    const t = target();
    expect(t.spec.intent).toBe("delete");
    expect(t.decommission.approvalId).toBe(decided.approvalId);
    expect(t.decommission.finalSnapshotName).toMatch(FINAL_SNAPSHOT_RE);
    // 日期与时刻分开(连续 12 位数字会被红线扫描当成账号号)
    expect(t.decommission.finalSnapshotName).toMatch(new RegExp(`^bgp-final-${SLUG}-\\d{8}-\\d{4}$`));
    expect(t.decommission.finalSnapshotName).toBe(r.finalSnapshotName);
    expect(t.decommission.retained.find((x: any) => x.kind === "redshift-snapshot").name).toBe(r.finalSnapshotName);
    expect(t.observed.phase).toBe("decommissioning");
    expect(t.observed.operation.kind).toBe("destroy");
    expect(t.status).toBe("decommissioning");
    expect(t.deployLockOperationId).toBe(t.observed.operation.operationId);
    // 已批准删除 ⇒ 不能改回承接
    await expect(setSpecIntent(TID, "serve", { expectedVersion: t.version })).rejects.toThrow(/删除已经批准/);
  });

  it("broker 起不来 ⇒ 计划已落库、审批成立;〔重试销毁〕沿用**同一个**快照名再起", async () => {
    const decided = await approveDeletion();
    h.brokerMode = "reject";
    await expect(startApprovedDestroy(decided, { username: "platform-admin" })).rejects.toMatchObject({ code: "BROKER_REJECTED" });
    const snap = target().decommission.finalSnapshotName;
    expect(target().spec.intent).toBe("delete");
    h.brokerMode = "plan";
    await expect(retryDestroy(TID, { confirm: "us-east-1" }, { username: "a" })).rejects.toMatchObject({ httpStatus: 400 });
    const r = await retryDestroy(TID, { confirm: "us-west-2" }, { username: "platform-admin" });
    expect(r.finalSnapshotName).toBe(snap);
    expect(target().observed.phase).toBe("decommissioning");
  });

  it("transitionPhase 不许走进 decommissioning(只有 broker 的 destroy 开会话能进)", async () => {
    await drain();
    const t = target();
    await expect(
      transitionPhase(TID, { from: "ready", expectedVersion: t.version, post: { spec: { ...t.spec, intent: "delete" }, observed: { ...t.observed, phase: "decommissioning" } }, reason: "x" })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
  });
});

describe("施工序 5:观测与收口 —— 真查 AWS ⇒ gone / 卡住点名;重试幂等", () => {
  async function destroying() {
    const decided = await approveDeletion();
    await startApprovedDestroy(decided, { username: "platform-admin" });
    const snap = target().decommission.finalSnapshotName;
    h.rs.workgroups[`bgp-workgroup-${SLUG}`] = "AVAILABLE";
    h.rs.namespaces[`bgp-namespace-${SLUG}`] = "AVAILABLE";
    return snap as string;
  }

  it("build 还在跑 ⇒ 只读回报 running,注册表一个字节都不写", async () => {
    await destroying();
    const before = structuredClone(target());
    h.buildStatus = "IN_PROGRESS";
    const v = await observeDecommission(TID);
    expect(v.state).toBe("running");
    expect(target()).toEqual(before);
  });

  it("build 成功 ∧ 真查全清 ⇒ deleted;锁 / 会话清掉;保留清单取构建报告;最终快照状态取真查", async () => {
    const snap = await destroying();
    h.buildStatus = "SUCCEEDED";
    h.stacks = {};
    h.vpcs = [];
    h.rs = { workgroups: {}, namespaces: {}, snapshots: { [snap]: "AVAILABLE" } };
    const report = { target: TID, region: "us-west-2", finalSnapshot: snap, ok: true, exitCode: 0, steps: [
      { step: "7-redshift", status: "retained", resource: `redshift-snapshot:${snap}`, detail: "最终快照(数仓数据)" },
      { step: "9-verify", status: "retained", resource: `s3:bgp-datalake-${ACCOUNT}-${SLUG}`, detail: "数据湖桶" },
    ] };
    h.logLines = ["destroy: …", `${DESTROY_REPORT_MARKER} ${JSON.stringify(report)}`];
    const v = await observeDecommission(TID);
    expect(v.state).toBe("settled-gone");
    const t = target();
    expect(t.status).toBe("deleted");
    expect(t.ready).toBe(false);
    expect(t.observed.phase).toBe("gone");
    expect(t.observed.operation).toBeUndefined();
    for (const k of ["deployLockToken", "deployLockOperationId", "deployLockExpiresAt"]) expect(t[k]).toBeUndefined();
    expect(t.observed.lastDestroy.finalSnapshot).toEqual({ name: snap, state: "AVAILABLE" });
    expect(t.observed.lastDestroy.retained.map((r: any) => r.name)).toEqual([snap, `bgp-datalake-${ACCOUNT}-${SLUG}`]);
    // ED-B5:同区重新注册成功(deleted 不占位)
    const reg = await registerTarget({ region: "us-west-2", partition: "aws", accountId: ACCOUNT, components: ["core", "redshift", "dms", "flink", "airflow-serverless"] }, "admin");
    expect(reg.targetId).toBe("tgt_usw2_b");
  });

  it("build 失败 ∧ core 栈 DELETE_FAILED ⇒ decommissioning + lastError 点名资源与真因;锁清掉;重试复用快照名", async () => {
    const snap = await destroying();
    h.buildStatus = "FAILED";
    h.stacks = { [`BgpExecEnv-${SLUG}-core`]: "DELETE_FAILED", [`BgpExecEnv-${SLUG}-base`]: "CREATE_COMPLETE" };
    h.stackEvents[`BgpExecEnv-${SLUG}-core`] = [{ ResourceStatus: "DELETE_FAILED", LogicalResourceId: "EmrSg", ResourceType: "AWS::EC2::SecurityGroup", ResourceStatusReason: "resource sg-1 has a dependent object" }];
    h.logLines = [`${DESTROY_REPORT_MARKER} ${JSON.stringify({ ok: false, exitCode: 1, steps: [], stuck: { step: "8-stacks", status: "stuck", resource: `stack:BgpExecEnv-${SLUG}-core`, detail: "DELETE_FAILED:EmrSg AWS::EC2::SecurityGroup resource sg-1 has a dependent object" } })}`];
    const v = await observeDecommission(TID);
    expect(v.state).toBe("settled-stuck");
    const t = target();
    expect(t.status).toBe("decommissioning");
    expect(t.observed.operation).toBeUndefined();
    expect(t.deployLockOperationId).toBeUndefined();
    expect(t.observed.lastError).toContain(`BgpExecEnv-${SLUG}-core`);
    expect(t.observed.lastError).toContain("dependent object");
    expect(t.observed.lastDestroy.remaining.some((x: string) => x.startsWith("stack:"))).toBe(true);
    expect((await previewDelete(TID)).stage).toBe("stuck");
    // 卡住态重探:仍有残留 ⇒ 原样,不写
    const before = structuredClone(target());
    expect((await observeDecommission(TID)).state).toBe("stuck");
    expect(target()).toEqual(before);
    // 重试:同一份计划、同一个快照名
    const r = await retryDestroy(TID, { confirm: "us-west-2" }, { username: "platform-admin" });
    expect(r.finalSnapshotName).toBe(snap);
    expect(target().decommission.finalSnapshotName).toBe(snap);
    expect(target().observed.operation.kind).toBe("destroy");
    expect(h.lambda.at(-1)).toEqual({ targetId: TID, operationId: r.operationId, mode: "destroy" });
  });

  it("🔴 看不清不算删完:EC2 查不了 ⇒ 卡住(不许判 gone);settleDestroy 直接喂「有残留的 gone」⇒ 抛且零写", async () => {
    await destroying();
    h.buildStatus = "SUCCEEDED";
    h.stacks = {};
    h.vpcs = [];
    h.rs = { workgroups: {}, namespaces: {}, snapshots: {} };
    h.ec2Denied = true;
    const v = await observeDecommission(TID);
    expect(v.state).toBe("settled-stuck");
    expect(target().observed.lastError).toMatch(/查不清/);
    const before = structuredClone(target());
    await expect(
      settleDestroy(TID, {
        fence: { expectedVersion: before.version },
        record: { at: new Date().toISOString(), outcome: "gone", buildStatus: "SUCCEEDED", checkedAt: new Date().toISOString(), remaining: ["vpc:vpc-1"], unverifiable: [], retained: [] },
      })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(target()).toEqual(before);
  });
});

describe("跨构建边界 parity:平台 ↔ broker ↔ 销毁脚本 用的是同一套字面", () => {
  it("FINAL_SNAPSHOT_RE / 可销毁阶段 与 broker validate.mjs 逐字相同;报告标记与销毁脚本逐字相同", async () => {
    const v = h.validate ?? (await import(BROKER_VALIDATE));
    expect(String(v.FINAL_SNAPSHOT_RE)).toBe(String(FINAL_SNAPSHOT_RE));
    expect([...v.DESTROYABLE_PHASES].sort()).toEqual([...DESTROYABLE_PHASES].sort());
    const sh = readFileSync(resolve(REPO, "infra/scripts/exec-env-destroy.sh"), "utf8");
    expect(sh).toContain(`"${DESTROY_REPORT_MARKER} "`);
  });
});
