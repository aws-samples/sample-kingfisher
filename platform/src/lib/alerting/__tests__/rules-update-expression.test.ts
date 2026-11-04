// 序 43 B-92 —— 告警规则「编辑」保存 400:updateRule 的 UpdateExpression 裸写了 DynamoDB 保留字 scope / condition
//   (真环境原话「Invalid UpdateExpression: Attribute name is a reserved keyword; reserved keyword: scope」,页面驱动 p43m A5 坐实)。
//   判据钉事实:发给 DDB 的 UpdateCommand 里,每个 SET 左值要么是 #别名(且别名表映射到真属性名),要么不是保留字;
//   同时钉 channels / events 两个同类构造器没有同一种病(只 mock 真外部 DDB)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ cmds: [] as Array<{ name: string; input: Record<string, unknown> }> }));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ALERT_RULES: "bgp-alert-rules", ALERT_CHANNELS: "bgp-alert-channels", ALERT_EVENTS: "bgp-alert-events" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.cmds.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") return { Item: { pk: "x", channelId: "c1", type: "webhook", webhookUrl: "https://x/y", enabled: true } };
      return { Attributes: { ...(cmd.input?.Key || {}), version: 2 } };
    }),
  },
}));

import { updateRule } from "@/lib/alerting/rules";
import { updateChannel } from "@/lib/alerting/channels";
import { updateEventDelivery } from "@/lib/alerting/events";

// DynamoDB 保留字(官方清单的常用子集;本仓属性名会撞上的都在)
const DDB_RESERVED = new Set([
  "NAME", "SCOPE", "CONDITION", "STATUS", "TYPE", "VALUE", "VALUES", "ROLE", "ROLES", "USER", "ORDER", "LEVEL", "ACTION", "STATE",
  "SOURCE", "TARGET", "REGION", "KEY", "KEYS", "TABLE", "TABLES", "INDEX", "PROJECT", "SIZE", "COUNT", "DATA", "DATE", "TIME", "TIMESTAMP",
  "FORMAT", "PATH", "SCHEMA", "FUNCTION", "OPERATOR", "USAGE", "ERROR", "EXCEPTION", "LANGUAGE", "LIMIT", "ROWS", "VIEW", "VIEWS", "OWNER",
  "PARAMETER", "PARAMETERS", "LOCATION", "COMMENT", "MODE", "GROUP", "LAST", "FIRST", "NEXT", "PRIMARY", "RESULT", "RESULTS", "OPTION",
  "LOG", "DOMAIN", "NUMBER", "OBJECT", "SESSION", "PLAN", "RESOURCE", "LIST", "METRIC", "METRICS", "POSITION", "RANGE", "WINDOW",
  "TAG", "TAGS", "UNIT", "UNITS", "URL", "TOKEN", "STORAGE", "STORE", "HASH", "CONNECTION", "AGENT", "PERCENT", "AVG", "MAX", "MIN",
  "SUM", "RETURN", "RETURNS", "HISTORY", "REQUEST", "RESPONSE", "CHECK", "TRIGGER", "COLUMN", "COLUMNS", "CONTAINS", "CONTENT", "CURRENT",
  "BATCH", "ACTIVE", "INACTIVE", "DEFAULT", "START", "STOP", "END", "BEGIN", "CLASS", "GLOBAL", "LOCAL", "PUBLIC", "PRIVATE", "SPACE",
]);

function setTargets(expr: string): string[] {
  const body = expr.replace(/^\s*SET\s+/i, "");
  return body.split(",").map((s) => s.trim().split(/\s*=\s*/)[0].trim()).filter(Boolean);
}

function assertNoBareReserved(cmd: { input: Record<string, unknown> }) {
  const expr = String(cmd.input.UpdateExpression);
  const names = (cmd.input.ExpressionAttributeNames as Record<string, string> | undefined) ?? {};
  for (const lhs of setTargets(expr)) {
    if (lhs.startsWith("#")) {
      expect(names[lhs], `别名 ${lhs} 必须在 ExpressionAttributeNames 里`).toBeTruthy();
      continue;
    }
    expect(DDB_RESERVED.has(lhs.toUpperCase()), `UpdateExpression 裸写了 DynamoDB 保留字 ${lhs}:${expr}`).toBe(false);
  }
}

beforeEach(() => { h.cmds.length = 0; });

describe("B-92 updateRule:scope / condition 走 ExpressionAttributeNames 别名", () => {
  it("整表单编辑(name + scope + condition + severity + channelIds + enrichWithDiagnosis + enabled + silenced)没有一个裸保留字;别名映射到真属性", async () => {
    await updateRule("r1", {
      name: "p43m-rule", scope: { taskType: "sync" }, condition: { type: "failure" }, severity: "P2",
      channelIds: ["c1"], enrichWithDiagnosis: false, enabled: true, silenced: false,
    }, 1);
    const upd = h.cmds.filter((c) => c.name === "UpdateCommand");
    expect(upd).toHaveLength(1);
    assertNoBareReserved(upd[0]);
    const names = upd[0].input.ExpressionAttributeNames as Record<string, string>;
    expect(Object.values(names).sort()).toEqual(["condition", "enabled", "name", "scope"]);
    const expr = String(upd[0].input.UpdateExpression);
    expect(expr).toContain("#sc = :sc");
    expect(expr).toContain("#cd = :cd");
    expect(expr).not.toMatch(/(^|[\s,])scope\s*=/);
    expect(expr).not.toMatch(/(^|[\s,])condition\s*=/);
    const values = upd[0].input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[":sc"]).toEqual(expect.objectContaining({ taskType: "sync" }));
    expect(values[":cd"]).toEqual(expect.objectContaining({ type: "failure" }));
    // 乐观锁没被改动
    expect(upd[0].input.ConditionExpression).toBe("version = :curV");
  });

  it("行内开关(只发 enabled / silenced)仍只更新那两个字段(这条路一直好着,别把它改坏)", async () => {
    await updateRule("r1", { enabled: false }, 3);
    const upd = h.cmds.filter((c) => c.name === "UpdateCommand");
    expect(upd).toHaveLength(1);
    assertNoBareReserved(upd[0]);
    expect(setTargets(String(upd[0].input.UpdateExpression))).toEqual(["updatedAt", "version", "#en"]);
    expect(upd[0].input.ExpressionAttributeNames).toEqual({ "#en": "enabled" });
  });
});

describe("同类构造器(channels / events)没有同一种病", () => {
  it("updateChannel 全字段", async () => {
    await updateChannel("c1", { name: "ch", webhookUrl: "https://x/sink", secret: "s", enabled: false } as any);
    const upd = h.cmds.filter((c) => c.name === "UpdateCommand");
    expect(upd).toHaveLength(1);
    assertNoBareReserved(upd[0]);
  });
  it("updateEventDelivery(status 已走 #s)", async () => {
    await updateEventDelivery("r1", "sk1", "delivered" as any, [], "diag-1");
    const upd = h.cmds.filter((c) => c.name === "UpdateCommand");
    expect(upd).toHaveLength(1);
    assertNoBareReserved(upd[0]);
  });
});
