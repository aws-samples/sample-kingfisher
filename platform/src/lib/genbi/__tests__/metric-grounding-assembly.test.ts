// 装配层判据:建模指标进问数,两条腿读到的是同一份。
//
// 问数的语义上下文有两个读者:平台进程(getContextForGrounding —— 进程内问数的提示、页面「本次参考了…」、
// 代码生成、Copilot、诊断)与智能体技能 Lambda(lookup_business_context —— AgentCore 那条腿真正喂给模型的)。
// 只测 core 的纯函数证明不了「两边都接上了」:平台可以忘了读指标表,Lambda 可以还在调旧函数。
// 所以这里把两边都**真跑**一遍:
//   · 行由产品自己的写入函数落进内存表(createContext / createModelMetric)⇒ 行形态就是真落库的形态;
//   · 平台侧真调 getContextForGrounding;
//   · Lambda 侧真加载 infra/lambda/genbi-skills/index.js(连同它 require 的入库编译产物 core-dist),
//     只把 AWS SDK 换成读同一份内存表的替身,真调 handler 的 lookup_business_context;
//   · 断言:Lambda 回给智能体的条目 == 平台条目经同一个对外映射后的结果,且其中有指标。
// 只 mock 真外部:DynamoDB(平台的 docClient / Lambda 的 SDK 客户端)与 OpenMetadata 术语推送。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Module, { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as utilDynamodb from "@aws-sdk/util-dynamodb";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const LAMBDA_INDEX = resolve(REPO, "infra/lambda/genbi-skills/index.js");

// ── 真外部:内存 DynamoDB(两张表;平台 docClient 与 Lambda 的 SDK 客户端读的是同一份)──
const db = vi.hoisted(() => ({
  tables: new Map<string, Array<Record<string, any>>>(),
  failTables: new Set<string>(),
  queries: [] as Array<{ by: string; table: string; pk: unknown }>,
}));
function queryRows(by: string, input: any): Array<Record<string, any>> {
  const table = String(input.TableName);
  const raw = Object.values(input.ExpressionAttributeValues || {})[0] as any;
  const pk = raw && typeof raw === "object" && "S" in raw ? raw.S : raw;
  db.queries.push({ by, table, pk });
  if (db.failTables.has(table)) throw new Error(`simulated read failure: ${table}`);
  const keyName = String(input.KeyConditionExpression).split("=")[0].trim();
  return (db.tables.get(table) || []).filter((r) => r[keyName] === pk);
}
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { GENBI_CONTEXT: "bgp-genbi-context", MODEL_METRICS: "bgp-model-metrics" },
  docClient: {
    send: async (cmd: any) => {
      const i = cmd.input;
      if (i.Item) { const t = db.tables.get(i.TableName) || []; t.push({ ...i.Item }); db.tables.set(i.TableName, t); return {}; }
      if (i.KeyConditionExpression) return { Items: queryRows("platform", i) };
      if (i.Key) return { Item: (db.tables.get(i.TableName) || []).find((r) => Object.entries(i.Key).every(([k, v]) => r[k] === v)) };
      throw new Error("装配层 mock 不认识这条 DynamoDB 调用");
    },
  },
}));
vi.mock("@/lib/openmetadata/om-glossary", () => ({ pushMetricGlossary: async () => {} }));

import { createContext, getContextForGrounding, contextToUsedItems } from "@/lib/genbi/context";
import { contextToGroundingItems } from "@/lib/genbi/core/context-format";
import { createModelMetric } from "@/lib/modeling/model-metrics";

// ── 真加载 Lambda:只把 AWS SDK 换成替身(DynamoDB 读同一份内存表;其余客户端本用例走不到)──
type Handler = (event: unknown, context: unknown) => Promise<any>;
let handler: Handler;
const realLoad = (Module as any)._load;
beforeAll(() => {
  class QueryCommand { constructor(public input: any) {} }
  class DynamoDBClient { async send(cmd: any) { return { Items: queryRows("lambda", cmd.input).map((r) => utilDynamodb.marshall(r, { removeUndefinedValues: true })) }; } }
  const inert = new Proxy({}, { get: () => class { async send() { throw new Error("本用例不该走到这个 AWS 客户端"); } } });
  (Module as any)._load = function (request: string, ...rest: unknown[]) {
    if (request === "@aws-sdk/client-dynamodb") return { DynamoDBClient, QueryCommand };
    // Lambda 运行时自带 SDK,函数目录里没有 node_modules ⇒ 属性编解码用平台依赖树里的同一个包
    if (request === "@aws-sdk/util-dynamodb") return utilDynamodb;
    if (request.startsWith("@aws-sdk/client-")) return inert;
    return realLoad.call(this, request, ...rest);
  };
  handler = createRequire(import.meta.url)(LAMBDA_INDEX).handler;
});
afterAll(() => { (Module as any)._load = realLoad; });

const lambdaLookup = (args: Record<string, unknown>) =>
  handler(args, { clientContext: { Custom: { bedrockAgentCoreToolName: "skills___lookup_business_context" } } });

describe("建模指标进问数:平台与技能 Lambda 读到同一份", () => {
  beforeEach(async () => {
    db.tables.clear(); db.failTables.clear(); db.queries.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    await createContext({ projectId: "proj-a", kind: "rule", title: "收入统一美元", body: "一律用 amount_usd", createdBy: "admin" });
    await createContext({ projectId: "global", kind: "term", title: "大R", body: "高付费玩家", scope: "payments", tags: ["VIP"], createdBy: "admin" });
    await createContext({ projectId: "proj-b", kind: "caliber", title: "别的项目的口径", body: "不该被 proj-a 看见" });
    const atom = await createModelMetric({ name: "订单总额", metricType: "atomic", caliber: "已支付订单的金额合计", unit: "元", fqn: "dev.public.orders", agg: "sum", measureColumn: "amount", timeColumn: "created_at" }, "admin");
    await createModelMetric({ name: "近30日华东订单总额", metricType: "derived", atomicId: atom.modelMetricId, timeWindow: "30d", modifiers: [{ column: "region", op: "=", value: "East" }] }, "admin");
  });

  it("两边都读了指标表(同一个分区键),条目逐项相同,且指标带着它的表与计算方式", async () => {
    const question = "近30日华东订单总额是多少";
    const platform = await getContextForGrounding("proj-a", question);
    const lambda = await lambdaLookup({ projectId: "proj-a", keywords: question });

    for (const by of ["platform", "lambda"]) {
      expect(db.queries.filter((q) => q.by === by && q.table === "bgp-model-metrics").map((q) => q.pk), by).toEqual(["modelmetric"]);
      expect(db.queries.filter((q) => q.by === by && q.table === "bgp-genbi-context").map((q) => q.pk).sort(), by).toEqual(["global", "proj-a"]);
    }

    expect(lambda.success).toBe(true);
    expect(lambda.entries).toEqual(contextToGroundingItems(platform));
    expect(lambda.count).toBe(platform.length);

    // 问题里提到的两个指标排在口径前面;别的项目的口径不在
    expect(platform).toHaveLength(4);
    expect(platform.slice(0, 2).map((e) => e.title).sort()).toEqual(["订单总额", "近30日华东订单总额"].sort());
    expect(platform.slice(2).map((e) => e.title).sort()).toEqual(["大R", "收入统一美元"].sort());
    expect(lambda.entries.find((e: any) => e.title === "近30日华东订单总额")).toEqual({
      kind: "建模指标", title: "近30日华东订单总额", scope: "public.orders", tags: [],
      definition: "数仓表 public.orders;计算方式 SUM(amount);过滤条件 region = 'East';时间范围 最近 30 天(自 30 天前零点起),按时间列 created_at;基于原子指标「订单总额」",
    });
    // 页面「本次参考了…」列的就是这份
    expect(contextToUsedItems(platform)).toContainEqual({ title: "订单总额", kindLabel: "建模指标", scope: "public.orders" });
  });

  it("指标表读失败 ⇒ 两边都降级成只有口径(不阻塞问数),结果仍然相同", async () => {
    db.failTables.add("bgp-model-metrics");
    const platform = await getContextForGrounding("proj-a", "订单总额");
    const lambda = await lambdaLookup({ projectId: "proj-a", keywords: "订单总额" });
    expect(platform.map((e) => e.title).sort()).toEqual(["大R", "收入统一美元"]);
    expect(lambda.entries).toEqual(contextToGroundingItems(platform));
  });

  it("指标定义改了(换了度量列)⇒ 下一次读到的就是新定义,没有第二份要同步", async () => {
    const row = (db.tables.get("bgp-model-metrics") || []).find((r) => r.name === "订单总额")!;
    row.measureColumn = "amount_usd";
    row.updatedAt = "2099-01-01T00:00:00.000Z";
    const platform = await getContextForGrounding("proj-a", "");
    const lambda = await lambdaLookup({ projectId: "proj-a" });
    expect(platform[0]).toMatchObject({ title: "订单总额", body: "已支付订单的金额合计;数仓表 public.orders;计算方式 SUM(amount_usd);单位 元" });
    expect(lambda.entries).toEqual(contextToGroundingItems(platform));
  });
});
