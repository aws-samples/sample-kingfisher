// @kf-batch 50-W5-seg2-WP8
// 单测用的内存 DynamoDB(DocumentClient 语义子集)。
//
// 🔴 为什么不用「按 UpdateExpression 前缀分派」的桩(run-lock.test.ts 那种):模块 51 的 store
// 走 **TransactWriteCommand(条件写 + ADD + Put 三项一事务)**,桩若只回 `{}` 就测不出
// 「事务任一项失败 ⇒ 全部不落」「条件失败 ⇒ 409」「事务里的审计 item 与 writeAuditRecord 同形」——
// 这些正是 51 SPEC §6.1③④ 的承重断言。所以这里真的解释表达式、真的做全有全无。
//
// 支持:Get / Put(条件) / Update(SET/ADD/REMOVE、if_not_exists、+、条件、UPDATED_NEW)/
//       Query(pk = :pk [AND begins_with(sk,:p)])/ Delete(条件)/ TransactWrite(Put/Update/Delete 全有全无)。
// 故障注入:`injectError((cmdName, input) => Error | null)`。
// 记录:`log[]` 保存每条命令(名 + input),供「写了几次事务」「ai-model# 写入无 ttl」等结构断言。

export type Item = Record<string, unknown>;

export interface MemDdb {
  tables: Map<string, Map<string, Item>>;
  log: { cmd: string; input: Record<string, any> }[];
  send: (cmd: { constructor: { name: string }; input?: Record<string, any> }) => Promise<any>;
  injectError: (fn: ((cmdName: string, input: Record<string, any>) => Error | null) | null) => void;
  /** 直接塞一条(不走表达式) */
  seed: (table: string, item: Item) => void;
  /** 读表全部项 */
  dump: (table: string) => Item[];
  reset: () => void;
}

class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}
class TransactionCanceledException extends Error {
  name = "TransactionCanceledException";
  CancellationReasons: { Code: string }[];
  constructor(reasons: { Code: string }[]) {
    super("Transaction cancelled");
    this.CancellationReasons = reasons;
  }
}

export function createMemDdb(keySchema: Record<string, string[]>): MemDdb {
  const tables = new Map<string, Map<string, Item>>();
  const log: MemDdb["log"] = [];
  let injector: ((cmdName: string, input: Record<string, any>) => Error | null) | null = null;

  const tbl = (name: string) => {
    let t = tables.get(name);
    if (!t) {
      t = new Map();
      tables.set(name, t);
    }
    return t;
  };
  const keyAttrs = (table: string) => {
    const ks = keySchema[table];
    if (!ks) throw new Error(`mem-ddb: 未登记表 ${table} 的键结构`);
    return ks;
  };
  const keyOf = (table: string, obj: Item) => keyAttrs(table).map((k) => `${k}=${String(obj[k])}`).join("|");

  // ── 表达式求值 ──
  const resolvePath = (raw: string, names: Record<string, string>) => {
    const p = raw.trim();
    return p.startsWith("#") ? names[p] ?? p : p;
  };
  const resolveVal = (raw: string, values: Record<string, unknown>, row: Item, names: Record<string, string>) => {
    const s = raw.trim();
    if (s.startsWith(":")) {
      if (!(s in values)) throw new Error(`mem-ddb: 缺 ExpressionAttributeValues ${s}`);
      return values[s];
    }
    return row[resolvePath(s, names)];
  };
  const evalOperand = (raw: string, values: Record<string, unknown>, row: Item, names: Record<string, string>): unknown => {
    const s = raw.trim();
    const m = s.match(/^if_not_exists\(([^,]+),([^)]+)\)$/);
    if (m) {
      const cur = row[resolvePath(m[1], names)];
      return cur === undefined ? resolveVal(m[2], values, row, names) : cur;
    }
    return resolveVal(s, values, row, names);
  };
  const evalExpr = (raw: string, values: Record<string, unknown>, row: Item, names: Record<string, string>): unknown => {
    const s = raw.trim();
    // a + b(顶层一个加号;if_not_exists 内部无加号)
    const plus = s.lastIndexOf(" + ");
    if (plus > 0) {
      const a = evalOperand(s.slice(0, plus), values, row, names) as number;
      const b = evalOperand(s.slice(plus + 3), values, row, names) as number;
      return Number(a ?? 0) + Number(b);
    }
    return evalOperand(s, values, row, names);
  };
  const splitTopLevelCommas = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  };
  const checkCondition = (cond: string | undefined, row: Item | undefined, values: Record<string, unknown>, names: Record<string, string>): boolean => {
    if (!cond) return true;
    return cond.split(/\s+AND\s+/i).every((clause) => {
      const c = clause.trim();
      let m = c.match(/^attribute_exists\(([^)]+)\)$/);
      if (m) return !!row && row[resolvePath(m[1], names)] !== undefined;
      m = c.match(/^attribute_not_exists\(([^)]+)\)$/);
      if (m) return !row || row[resolvePath(m[1], names)] === undefined;
      m = c.match(/^(\S+)\s*(=|<>)\s*(\S+)$/);
      if (m) {
        const left = row ? row[resolvePath(m[1], names)] : undefined;
        const right = resolveVal(m[3], values, row ?? {}, names);
        return m[2] === "=" ? left === right : left !== right;
      }
      throw new Error(`mem-ddb: 不支持的条件 ${c}`);
    });
  };
  const applyUpdate = (row: Item, expr: string, values: Record<string, unknown>, names: Record<string, string>): Item => {
    const next: Item = { ...row };
    const changed: Item = {};
    const parts = expr.split(/\b(SET|ADD|REMOVE)\b/).map((p) => p.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i += 2) {
      const kw = parts[i];
      const body = parts[i + 1] ?? "";
      if (kw === "SET") {
        for (const asg of splitTopLevelCommas(body)) {
          const eq = asg.indexOf("=");
          const path = resolvePath(asg.slice(0, eq), names);
          const val = evalExpr(asg.slice(eq + 1), values, next, names);
          next[path] = val;
          changed[path] = val;
        }
      } else if (kw === "ADD") {
        for (const pair of splitTopLevelCommas(body)) {
          const [p, v] = pair.trim().split(/\s+/);
          const path = resolvePath(p, names);
          const val = Number((next[path] as number | undefined) ?? 0) + Number(resolveVal(v, values, next, names));
          next[path] = val;
          changed[path] = val;
        }
      } else if (kw === "REMOVE") {
        for (const p of splitTopLevelCommas(body)) delete next[resolvePath(p, names)];
      }
    }
    return Object.assign(next, { __changed: changed });
  };

  // ── 单条操作(在给定表状态上执行;事务用副本)──
  type Op = { kind: "Put" | "Update" | "Delete"; input: Record<string, any> };
  const runOp = (state: Map<string, Map<string, Item>>, op: Op): Item | undefined => {
    const input = op.input;
    const table = input.TableName as string;
    let t = state.get(table);
    if (!t) {
      t = new Map();
      state.set(table, t);
    }
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};
    if (op.kind === "Put") {
      const item = input.Item as Item;
      const k = keyOf(table, item);
      if (!checkCondition(input.ConditionExpression, t.get(k), values, names)) throw new ConditionalCheckFailedException("condition failed");
      t.set(k, { ...item });
      return undefined;
    }
    const k = keyOf(table, input.Key as Item);
    const row = t.get(k);
    if (op.kind === "Delete") {
      if (!checkCondition(input.ConditionExpression, row, values, names)) throw new ConditionalCheckFailedException("condition failed");
      t.delete(k);
      return undefined;
    }
    if (!checkCondition(input.ConditionExpression, row, values, names)) throw new ConditionalCheckFailedException("condition failed");
    const base: Item = row ? { ...row } : { ...(input.Key as Item) };
    const next = applyUpdate(base, input.UpdateExpression as string, values, names);
    const changed = next.__changed as Item;
    delete next.__changed;
    t.set(k, next);
    return changed;
  };

  const send: MemDdb["send"] = async (cmd) => {
    const name = cmd.constructor.name;
    const input = cmd.input || {};
    log.push({ cmd: name, input });
    const injected = injector?.(name, input);
    if (injected) throw injected;

    switch (name) {
      case "GetCommand": {
        const t = tbl(input.TableName);
        const item = t.get(keyOf(input.TableName, input.Key));
        return { Item: item ? { ...item } : undefined };
      }
      case "PutCommand":
        runOp(tables, { kind: "Put", input });
        return {};
      case "DeleteCommand":
        runOp(tables, { kind: "Delete", input });
        return {};
      case "UpdateCommand": {
        const changed = runOp(tables, { kind: "Update", input });
        return input.ReturnValues === "UPDATED_NEW" ? { Attributes: changed } : {};
      }
      case "QueryCommand": {
        const t = tbl(input.TableName);
        const values = input.ExpressionAttributeValues || {};
        const kce = String(input.KeyConditionExpression || "");
        const pkm = kce.match(/(\w+)\s*=\s*(:\w+)/);
        const bw = kce.match(/begins_with\((\w+),\s*(:\w+)\)/);
        let items = Array.from(t.values()).filter((it) => (pkm ? it[pkm[1]] === values[pkm[2]] : true));
        if (bw) items = items.filter((it) => String(it[bw[1]] ?? "").startsWith(String(values[bw[2]])));
        const sk = keyAttrs(input.TableName)[1];
        if (sk) items.sort((a, b) => String(a[sk]).localeCompare(String(b[sk])));
        if (input.ScanIndexForward === false) items.reverse();
        if (input.Limit) items = items.slice(0, input.Limit);
        return { Items: items.map((i) => ({ ...i })) };
      }
      case "TransactWriteCommand": {
        // 全有全无:在深拷贝上跑,任一条件失败 ⇒ 抛 TransactionCanceledException 且原表不动。
        const copy = new Map<string, Map<string, Item>>();
        for (const [tn, t] of tables) copy.set(tn, new Map(Array.from(t.entries()).map(([k, v]) => [k, { ...v }])));
        const reasons: { Code: string }[] = [];
        let failed = false;
        for (const ti of input.TransactItems as Record<string, any>[]) {
          const kind = (Object.keys(ti)[0] as "Put" | "Update" | "Delete");
          try {
            runOp(copy, { kind, input: ti[kind] });
            reasons.push({ Code: "None" });
          } catch (e) {
            if (e instanceof ConditionalCheckFailedException) {
              reasons.push({ Code: "ConditionalCheckFailed" });
              failed = true;
            } else throw e;
          }
        }
        if (failed) throw new TransactionCanceledException(reasons);
        for (const [tn, t] of copy) tables.set(tn, t);
        return {};
      }
      default:
        throw new Error(`mem-ddb: 不支持的命令 ${name}`);
    }
  };

  return {
    tables,
    log,
    send,
    injectError: (fn) => {
      injector = fn;
    },
    seed: (table, item) => {
      tbl(table).set(keyOf(table, item), { ...item });
    },
    dump: (table) => Array.from(tbl(table).values()).map((i) => ({ ...i })),
    reset: () => {
      tables.clear();
      log.length = 0;
      injector = null;
    },
  };
}
