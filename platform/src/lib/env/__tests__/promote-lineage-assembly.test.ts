// 发布(晋升)服务的装配层判据:只 mock 真外部(DynamoDB 文档客户端),
//   版本服务 / 审批服务 / 发布服务之间**不 mock**,钉的是落库事实:
//   ① 首次发布在目标环境新建一份并写下发布痕迹(promotedFrom / promotedAt / promotedBy / sourceId / sourceVersion),源行得到 lineageId;
//   ② 再发一次是更新同一份(幂等),痕迹刷新;
//   ③ 从 prod 那份再发到 staging 时,prod 的痕迹**不被带走**(PROMOTE_EXCLUDE),staging 的痕迹指向 prod;
//   ④ lineageStatus 按 lineage 列出三个环境各一行,当前环境标 current,待批准的 deploy 审批挂到目标环境。
import { describe, it, expect, beforeEach, vi } from "vitest";

type Item = Record<string, any>;
// vi.mock 工厂会被提升到文件顶部 ⇒ 它引用的状态必须用 vi.hoisted 声明
const H = vi.hoisted(() => ({ store: {} as Record<string, Map<string, Record<string, any>>>, KEYS: {} as Record<string, string[]> }));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as { TABLES: Record<string, string> };
  const T = real.TABLES;
  H.KEYS = {
    [T.ETL_JOBS]: ["userId", "jobId"], [T.SYNC_TASKS]: ["userId", "taskId"], [T.WORKFLOWS]: ["userId", "workflowId"],
    [T.ENGINE_JOBS]: ["userId", "jobId"], [T.REDSHIFT_TASKS]: ["userId", "taskId"],
    [T.RESOURCE_VERSIONS]: ["pk", "version"], [T.APPROVALS]: ["pk", "approvalId"],
  };
  const tbl = (n: string) => (H.store[n] ||= new Map());
  const keyOf = (table: string, obj: Item) => (H.KEYS[table] || Object.keys(obj).slice(0, 2)).map((k) => String(obj[k])).join("|");
  const resolve = (ref: string, names: Item = {}, values: Item = {}, item?: Item) =>
    ref.trim().startsWith(":") ? values[ref.trim()] : item?.[names[ref.trim()] || ref.trim()];
  const matches = (expr: string, names: Item, values: Item, item: Item) =>
    expr.split(/\s+AND\s+/i).every((clause) => {
      const m = /^\s*([#\w]+)\s*=\s*(:[\w]+)\s*$/.exec(clause);
      if (!m) throw new Error(`mock 不认识的条件:${clause}`);
      return resolve(m[1], names, values, item) === resolve(m[2], names, values, item);
    });
  const send = async (cmd: any) => {
    const n = cmd.constructor.name; const i = cmd.input;
    if (n === "GetCommand") return { Item: tbl(i.TableName).get(keyOf(i.TableName, i.Key)) };
    if (n === "PutCommand") { tbl(i.TableName).set(keyOf(i.TableName, i.Item), { ...i.Item }); return {}; }
    if (n === "ScanCommand") {
      const items = Array.from(tbl(i.TableName).values()).filter((it) => !i.FilterExpression || matches(i.FilterExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues, it));
      return { Items: items };
    }
    if (n === "QueryCommand") {
      let items = Array.from(tbl(i.TableName).values()).filter((it) => matches(i.KeyConditionExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues, it));
      items.sort((a, b) => String(a.version).localeCompare(String(b.version)));
      if (i.ScanIndexForward === false) items.reverse();
      if (i.Limit) items = items.slice(0, i.Limit);
      return { Items: items };
    }
    if (n === "UpdateCommand") {
      const key = keyOf(i.TableName, i.Key);
      const item = tbl(i.TableName).get(key);
      if (!item) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      const expr: string = i.UpdateExpression.replace(/^\s*SET\s+/i, "");
      for (const part of expr.split(/,\s*/)) {
        const m = /^([#\w]+)\s*=\s*(:[\w]+)$/.exec(part.trim());
        if (!m) throw new Error(`mock 不认识的 SET:${part}`);
        item[(i.ExpressionAttributeNames || {})[m[1]] || m[1]] = (i.ExpressionAttributeValues || {})[m[2]];
      }
      return { Attributes: item };
    }
    throw new Error(`mock 未实现:${n}`);
  };
  return { ...real, docClient: { send } };
});

import { TABLES } from "@/lib/aws/dynamodb";
import { executePromote, lineageStatus } from "../promote-service";

const put = (table: string, item: Item) => H.store[table]!.set(H.KEYS[table].map((k) => String(item[k])).join("|"), item);
const all = (table: string) => Array.from((H.store[table] || new Map()).values());

beforeEach(() => {
  H.store = {};
  for (const t of Object.values(H.KEYS)) void t;
  for (const t of [TABLES.ETL_JOBS, TABLES.RESOURCE_VERSIONS, TABLES.APPROVALS]) H.store[t] = new Map();
  put(TABLES.ETL_JOBS, { userId: "default-user", jobId: "job-dev", projectId: "proj-x", env: "dev", name: "J", type: "redshift", sql: "select 1", status: "active", glueJobName: "glue-dev" });
  put(TABLES.RESOURCE_VERSIONS, { pk: "etl-job#job-dev", version: "000001", versionNum: 1 });
  put(TABLES.RESOURCE_VERSIONS, { pk: "etl-job#job-dev", version: "000002", versionNum: 2 });
});

describe("executePromote 的发布痕迹", () => {
  it("① 首发到 prod:新建一份带 promotedFrom/At/By · sourceId · sourceVersion=2;运行态字段不带过去;源行写 lineageId", async () => {
    const r = await executePromote("etl-job", "job-dev", "prod", "alice");
    expect(r.created).toBe(true);
    expect(r).toMatchObject({ fromEnv: "dev", toEnv: "prod", lineageId: "job-dev", sourceId: "job-dev", sourceVersion: 2 });
    expect(r.promotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const prod = all(TABLES.ETL_JOBS).find((x) => x.env === "prod")!;
    expect(prod).toMatchObject({ jobId: r.targetId, lineageId: "job-dev", status: "draft", promotedFrom: "dev", promotedBy: "alice", sourceId: "job-dev", sourceVersion: 2, sql: "select 1", name: "J" });
    expect(prod.promotedAt).toBe(r.promotedAt);
    expect(prod.glueJobName).toBeUndefined();
    expect(all(TABLES.ETL_JOBS).find((x) => x.jobId === "job-dev")!.lineageId).toBe("job-dev");
  });

  it("② 再发一次 = 更新同一份(prod 仍只有 1 行),痕迹刷新为新的操作人", async () => {
    const a = await executePromote("etl-job", "job-dev", "prod", "alice");
    const b = await executePromote("etl-job", "job-dev", "prod", "bob");
    expect(b.created).toBe(false);
    expect(b.targetId).toBe(a.targetId);
    const prods = all(TABLES.ETL_JOBS).filter((x) => x.env === "prod");
    expect(prods).toHaveLength(1);
    expect(prods[0]).toMatchObject({ promotedBy: "bob", promotedFrom: "dev", sourceId: "job-dev", sourceVersion: 2 });
  });

  it("③ 从 prod 那份发到 staging:staging 的痕迹指向 prod(sourceId = prod id,promotedBy = 本次操作人),不继承 prod 的痕迹", async () => {
    const a = await executePromote("etl-job", "job-dev", "prod", "alice");
    const s = await executePromote("etl-job", a.targetId, "staging", "carol");
    const st = all(TABLES.ETL_JOBS).find((x) => x.env === "staging")!;
    expect(s.created).toBe(true);
    expect(st).toMatchObject({ lineageId: "job-dev", promotedFrom: "prod", promotedBy: "carol", sourceId: a.targetId });
    expect(st.promotedBy).not.toBe("alice");
    expect(st.sourceId).not.toBe("job-dev");
  });
});

describe("lineageStatus", () => {
  it("④ 三环境各一行:当前环境 current,已发布的带 id 与痕迹,没发布的 id 为空;待批准的 deploy 审批挂到目标环境", async () => {
    const a = await executePromote("etl-job", "job-dev", "prod", "alice");
    put(TABLES.APPROVALS, { pk: "approval", approvalId: "ap-1", projectId: "proj-x", type: "deploy", status: "pending",
      payload: { resourceType: "etl-job", resourceId: "job-dev", toEnv: "staging" }, requestedBy: "dave", requestedAt: "2026-10-19T08:00:00.000Z" });
    put(TABLES.APPROVALS, { pk: "approval", approvalId: "ap-other", projectId: "proj-x", type: "deploy", status: "pending",
      payload: { resourceType: "etl-job", resourceId: "someone-else", toEnv: "staging" }, requestedBy: "x", requestedAt: "2026-10-19T08:00:00.000Z" });
    const st = await lineageStatus("etl-job", "job-dev");
    expect(st.lineageId).toBe("job-dev");
    expect(st.current).toEqual({ env: "dev", id: "job-dev" });
    const by = Object.fromEntries(st.envs.map((r) => [r.env, r]));
    expect(by.dev).toMatchObject({ id: "job-dev", current: true, pendingApproval: null });
    expect(by.prod).toMatchObject({ id: a.targetId, current: false, promotedFrom: "dev", promotedBy: "alice", sourceVersion: 2, pendingApproval: null });
    expect(by.staging).toMatchObject({ id: null, current: false });
    expect(by.staging.pendingApproval).toEqual({ approvalId: "ap-1", requestedBy: "dave", requestedAt: "2026-10-19T08:00:00.000Z" });
    // 从 prod 那份看回来:current 换成 prod,dev 行仍能找到源
    const back = await lineageStatus("etl-job", a.targetId);
    expect(back.current).toEqual({ env: "prod", id: a.targetId });
    expect(back.envs.find((r) => r.env === "dev")!.id).toBe("job-dev");
  });
});
