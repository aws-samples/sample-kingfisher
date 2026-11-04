// @kf-batch 50-W3f-T0-T3
// 门票 T3:数据源落点 `ownerTargetId` —— 新建即盖 / 存量迁移只补空缺 / PUT 不可改 / 建源两路径同源。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  items: [] as Array<Record<string, any>>,
  updates: [] as Array<Record<string, any>>,
}));

class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      const kind = cmd.constructor.name;
      if (kind === "ScanCommand") {
        const attr = cmd.input.ExpressionAttributeNames["#o"];
        expect(cmd.input.FilterExpression).toBe("attribute_not_exists(#o)");
        const missing = h.items.filter((i) => i[attr] === undefined);
        return { Items: missing.map((i) => ({ userId: i.userId, datasourceId: i.datasourceId })), ScannedCount: h.items.length };
      }
      if (kind === "UpdateCommand") {
        const row = h.items.find((i) => i.datasourceId === cmd.input.Key.datasourceId);
        const attr = cmd.input.ExpressionAttributeNames["#o"];
        if (!row || row[attr] !== undefined) throw new ConditionalCheckFailedException("cond");
        h.updates.push(cmd.input);
        row[attr] = cmd.input.ExpressionAttributeValues[":home"];
        return {};
      }
      throw new Error(`unexpected ${kind}`);
    }),
  },
}));

const { placementForNewDataSource, backfillDataSourcePlacement, DATASOURCE_OWNER_TARGET_ATTR } = await import(
  "@/lib/datasource/placement"
);

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

beforeEach(() => {
  h.items = [];
  h.updates.length = 0;
});

describe("T3:新建盖章", () => {
  it("新建数据源的落点 = home(一期建源只发生在 home;显式写、不省略)", () => {
    expect(placementForNewDataSource()).toEqual({ [DATASOURCE_OWNER_TARGET_ATTR]: "tgt_home" });
    expect(DATASOURCE_OWNER_TARGET_ATTR).toBe("ownerTargetId");
  });
});

describe("🔴 T3:存量迁移只补空缺、不碰 updatedAt、可反复", () => {
  it("3 条存量无落点 ⇒ 3 条补成 tgt_home;已有落点的一个字节不动", async () => {
    h.items = [
      { userId: "u", datasourceId: "a" },
      { userId: "u", datasourceId: "b" },
      { userId: "u", datasourceId: "c" },
      { userId: "u", datasourceId: "d", ownerTargetId: "tgt_usw2_a" },
    ];
    const r = await backfillDataSourcePlacement();
    expect(r).toEqual({ scanned: 4, backfilled: 3, alreadyPlaced: 1 });
    expect(h.items.map((i) => i.ownerTargetId)).toEqual(["tgt_home", "tgt_home", "tgt_home", "tgt_usw2_a"]);
    for (const u of h.updates) {
      expect(u.ConditionExpression).toContain("attribute_not_exists(#o)");
      expect(u.UpdateExpression, "系统迁移不许冒充用户编辑").not.toContain("updatedAt");
    }
  });

  it("第二次执行 ⇒ 零写入(幂等)", async () => {
    h.items = [{ userId: "u", datasourceId: "a" }];
    await backfillDataSourcePlacement();
    h.updates.length = 0;
    const r = await backfillDataSourcePlacement();
    expect(r).toEqual({ scanned: 1, backfilled: 0, alreadyPlaced: 1 });
    expect(h.updates).toEqual([]);
  });
});

describe("🔴 T3 接线门禁:建源两条路径都盖章;PUT 不许改落点", () => {
  it("建源两条路径(route.ts 非 JDBC + 序 57 / B-129 起 JDBC 主体在 lib/datasource/long-ops.ts):每一个写 DATASOURCES 的 Item 都展开了 placementForNewDataSource()", () => {
    // 序 57 / B-129:JDBC 建源的落库搬进长操作执行体(datasource-create),路由只剩非 JDBC 那一条写入点;两文件合起来仍是两条路径、两处盖章
    const route = stripComments(read("app/api/datasources/route.ts"));
    const executor = stripComments(read("lib/datasource/long-ops.ts"));
    const putsOf = (s: string) => s.match(/TableName:\s*TABLES\.DATASOURCES,\s*Item:/g) ?? [];
    const spreadsOf = (s: string) => s.match(/\.\.\.placementForNewDataSource\([^)]*\)/g) ?? [];
    expect(putsOf(route).length, "路由里建源写入点数变了,请同步").toBe(1);
    expect(putsOf(executor).length, "执行体里建源写入点数变了,请同步").toBe(1);
    expect(spreadsOf(route).length + spreadsOf(executor).length, "有一条建源路径没盖落点 ⇒ 新建行与存量行在数据上无法区分,迁移永远做不完").toBe(2);
    const src = route + "\n" + executor;
    // @kf-batch 50-WP4quater-reads(工单 SC-2)—— 🔴 判据加强:**空括号形态不许再出现**。
    // 空括号 = 又把落点钉死主控区,而用户 2026-09-10 的原话是「所有的任务都要创建在当前区域,
    // 不能只是创建在主控区,没意义…不然也是白干了」。两条路径都必须传解析过的落点。
    expect(
      src.match(/placementForNewDataSource\(\s*\)/g) ?? [],
      "placementForNewDataSource() 空参调用 = 落点又被钉死主控区"
    ).toEqual([]);
    expect(src, "落点必须先真解析过(缺网络 / 缺角色 ⇒ 400 可修,而不是建出半截资源)").toContain("resolveDsPlace(");
    // 建 AWS 资源的每一步都要带上那个区(密钥 / 网络 / Glue 连接 / 测连接)
    for (const step of [
      "createSecret(datasourceId, rdsSecret.username, rdsSecret.password, dsPlace.region)",
      "detectNetwork(host, type, datasourceId, dsPlace)",
      "secretArn, networkConfig, dsPlace.region, jdbcParams || undefined)", // 序 44:Glue 连接还带用户附加 JDBC 参数,区仍在同一调用里
      "testConnection(glueConnectionName, dsPlace.region)",
    ]) {
      expect(src, `建源的这一步没带落点区域:${step}`).toContain(step);
    }
  });

  it("datasources/[id]/route.ts(PUT):ownerTargetId 与 projectId 同列不可变", () => {
    const src = stripComments(read("app/api/datasources/[id]/route.ts"));
    expect(src).toContain("delete body.projectId;");
    expect(src).toContain("delete body.ownerTargetId;");
  });

  it("类型里有这个字段,且注释以外的代码里没有第二个属性名字面量(单一真值 = placement-shared)", () => {
    const types = read("types/datasource.ts");
    expect(types).toMatch(/^\s*ownerTargetId\?: string;/m);
    const shared = stripComments(read("lib/datasource/placement-shared.ts"));
    expect(shared).toContain('"ownerTargetId"');
  });
});
