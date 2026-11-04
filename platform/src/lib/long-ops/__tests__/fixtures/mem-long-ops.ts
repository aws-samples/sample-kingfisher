// 模块 55 — 判据夹具:内存版 bgp-long-ops(只替真外部 DynamoDB;条件写 / SET 表达式按 lib/long-ops/store.ts 真用到的形态求值)。
// 原 序 46 B-107 的 mem-ai-tasks 改名泛化。
// 用法:`vi.mock("@/lib/aws/dynamodb", () => import("./fixtures/mem-long-ops"))`,再从本模块 import `rows` 读真值。
// 🔴 条件表达式不是「永远通过」——抢占 / 重认领 / 终态条件写的并发正确性正是被测的东西,mock 回自己编的值 = 空断言。

export const TABLES = { LONG_OPS: "bgp-long-ops" } as const;

export const rows = new Map<string, Record<string, any>>();
export const sendLog: Array<{ op: string; input: Record<string, any> }> = [];

export function resetMemLongOps(): void {
  rows.clear();
  sendLog.length = 0;
}

function conditionalFail(): Error {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

function resolveName(token: string, names: Record<string, string> | undefined): string {
  return token.startsWith("#") ? (names?.[token] ?? token) : token;
}

/** 只认 store.ts 真写出的几种原子条件;碰到认不出的形态直接抛,免得判据在不知不觉中放行。 */
function evalCondition(expr: string, item: Record<string, any> | undefined, names: Record<string, string> | undefined, values: Record<string, any>): boolean {
  const atom = (s: string): boolean => {
    s = s.trim();
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^attribute_exists\((\w+)\)$/))) return !!item && item[m[1]] !== undefined;
    if ((m = s.match(/^attribute_not_exists\((\w+)\)$/))) return !item || item[m[1]] === undefined;
    if ((m = s.match(/^([#\w]+)\s*(=|<=|>)\s*(:\w+)$/))) {
      const left = item?.[resolveName(m[1], names)];
      const right = values[m[3]];
      if (m[2] === "=") return left === right;
      if (left === undefined) return false;
      return m[2] === "<=" ? left <= right : left > right;
    }
    throw new Error(`mem-long-ops:认不出的条件原子「${s}」`);
  };
  const orGroup = (s: string): boolean => s.split(/\s+OR\s+/).some((part) => atom(part));
  // AND 的各项可能是带括号的 OR 组
  const parts: string[] = [];
  let depth = 0; let cur = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && expr.slice(i, i + 5) === " AND ") { parts.push(cur); cur = ""; i += 4; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.every((part) => {
    const trimmed = part.trim();
    return trimmed.startsWith("(") ? orGroup(trimmed.slice(1, -1)) : atom(trimmed);
  });
}

function applySet(expr: string, item: Record<string, any>, names: Record<string, string> | undefined, values: Record<string, any>): void {
  const body = expr.replace(/^SET\s+/, "");
  for (const assignment of body.split(",")) {
    const m = assignment.trim().match(/^([#\w]+)\s*=\s*(:\w+)$/);
    if (!m) throw new Error(`mem-long-ops:认不出的 SET 项「${assignment}」`);
    item[resolveName(m[1], names)] = values[m[2]];
  }
}

export const docClient = {
  send: async (cmd: any) => {
    const input = cmd.input as Record<string, any>;
    const op = cmd.constructor.name as string;
    sendLog.push({ op, input });
    if (input.TableName !== TABLES.LONG_OPS) throw new Error(`mem-long-ops:意外的表 ${input.TableName}`);
    if (op === "PutCommand") {
      const found = rows.get(input.Item.taskId);
      if (input.ConditionExpression && !evalCondition(input.ConditionExpression, found, input.ExpressionAttributeNames, input.ExpressionAttributeValues || {})) {
        throw conditionalFail();
      }
      rows.set(input.Item.taskId, JSON.parse(JSON.stringify(input.Item)));
      return {};
    }
    if (op === "DeleteCommand") {
      const found = rows.get(input.Key.taskId);
      if (input.ConditionExpression && !evalCondition(input.ConditionExpression, found, input.ExpressionAttributeNames, input.ExpressionAttributeValues || {})) {
        throw conditionalFail();
      }
      rows.delete(input.Key.taskId);
      return {};
    }
    if (op === "GetCommand") {
      const found = rows.get(input.Key.taskId);
      return found ? { Item: JSON.parse(JSON.stringify(found)) } : {};
    }
    if (op === "UpdateCommand") {
      const found = rows.get(input.Key.taskId);
      if (input.ConditionExpression && !evalCondition(input.ConditionExpression, found, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
        throw conditionalFail();
      }
      const target = found ?? { taskId: input.Key.taskId };
      applySet(input.UpdateExpression, target, input.ExpressionAttributeNames, input.ExpressionAttributeValues);
      rows.set(input.Key.taskId, target);
      return input.ReturnValues === "ALL_NEW" ? { Attributes: JSON.parse(JSON.stringify(target)) } : {};
    }
    throw new Error(`mem-long-ops:未实现的命令 ${op}`);
  },
};
