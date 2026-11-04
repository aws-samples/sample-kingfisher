// 测试用的**内存 DynamoDB**(只 mock 真外部;本包的装配层判据都用它)。
//
// 🔴 为什么要一个真求值器,而不是像别处那样「只认得几条写死的 ConditionExpression」:
//    本包的承重全在条件写(claim 的 `revision = :r AND (租约空 OR 已过期)`、commit 的 `runToken ∧ revision`、
//    入队的 `attribute_not_exists(jobId)`、registry 延期的 `前态 ∧ epoch`)。若假表只认写死的字符串,
//    改坏一个条件的变异会直接让假表「不认识」而抛 —— 那测的是假表,不是条件。
//    这里实现 DynamoDB 表达式语法里**本仓用到的子集**,按语义求值:
//      条件:AND / OR / NOT / 括号 / attribute_exists / attribute_not_exists / = <> < <= > >= / 嵌套路径 #a.#b
//      更新:SET a = v[, …](v = :x | path | if_not_exists(path, v) | v + v | v - v)/ REMOVE p[, …] / ADD p :n
//      查询:KeyConditionExpression(= 与 <= < >= > BETWEEN 不支持 —— 没用到)、FilterExpression、IndexName、
//            ScanIndexForward、Limit(过滤**之前**生效,与真 DDB 一致)、Select COUNT、ExclusiveStartKey 翻页
//    不认识的语法一律抛(不许静默放行)。
// 🔴 每次 send 之前先 `await` 一拍:让并发的两个调用方真的交错(双泵抢同一条的判据靠它)。

type Item = Record<string, any>;

interface TableSpec {
  hash: string;
  range?: string;
  indexes?: Record<string, { hash: string; range?: string }>;
}

export class ConditionalCheckFailed extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

// ── 词法 ─────────────────────────────────────────────────────────────────────
type Tok = { t: "name" | "val" | "id" | "op" | "(" | ")" | "," | "."; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === "," || c === ".") { out.push({ t: c, v: c }); i++; continue; }
    if (c === "#" || c === ":") {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: c === "#" ? "name" : "val", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("=<>+-".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`fake-ddb 不认识的字符 ${JSON.stringify(c)} in ${src}`);
  }
  return out;
}

class Parser {
  private p = 0;
  constructor(private toks: Tok[], private names: Record<string, string>, private vals: Record<string, any>) {}
  peek(): Tok | undefined { return this.toks[this.p]; }
  next(): Tok { const t = this.toks[this.p++]; if (!t) throw new Error("fake-ddb 表达式意外结束"); return t; }
  done(): boolean { return this.p >= this.toks.length; }
  expect(t: Tok["t"], v?: string): Tok {
    const x = this.next();
    if (x.t !== t || (v !== undefined && x.v.toUpperCase() !== v)) throw new Error(`fake-ddb 期望 ${t} ${v ?? ""},得到 ${x.v}`);
    return x;
  }
  isKw(v: string): boolean { const t = this.peek(); return !!t && t.t === "id" && t.v.toUpperCase() === v; }

  path(): string[] {
    const seg = () => {
      const t = this.next();
      if (t.t === "name") { const n = this.names[t.v]; if (n === undefined) throw new Error(`fake-ddb 未定义的名字 ${t.v}`); return n; }
      if (t.t === "id") return t.v;
      throw new Error(`fake-ddb 期望路径,得到 ${t.v}`);
    };
    const out = [seg()];
    while (this.peek()?.t === ".") { this.next(); out.push(seg()); }
    return out;
  }

  // ── 条件 ──
  cond(item: Item | undefined): boolean {
    let v = this.andExpr(item);
    while (this.isKw("OR")) { this.next(); const r = this.andExpr(item); v = v || r; }
    return v;
  }
  andExpr(item: Item | undefined): boolean {
    let v = this.unary(item);
    while (this.isKw("AND")) { this.next(); const r = this.unary(item); v = v && r; }
    return v;
  }
  unary(item: Item | undefined): boolean {
    if (this.isKw("NOT")) { this.next(); return !this.unary(item); }
    if (this.peek()?.t === "(") { this.next(); const v = this.cond(item); this.expect(")"); return v; }
    if (this.isKw("ATTRIBUTE_EXISTS") || this.isKw("ATTRIBUTE_NOT_EXISTS")) {
      const fn = this.next().v.toLowerCase();
      this.expect("(");
      const p = this.path();
      this.expect(")");
      const has = getPath(item, p) !== undefined;
      return fn === "attribute_exists" ? has : !has;
    }
    const a = this.operand(item);
    const op = this.expect("op").v;
    const b = this.operand(item);
    return compare(a, op, b);
  }
  operand(item: Item | undefined): any {
    const t = this.peek();
    if (t?.t === "val") { this.next(); if (!(t.v in this.vals)) throw new Error(`fake-ddb 未定义的值 ${t.v}`); return this.vals[t.v]; }
    return getPath(item, this.path());
  }

  // ── 更新值 ──
  value(item: Item): any {
    let v = this.term(item);
    while (this.peek()?.t === "op" && (this.peek()!.v === "+" || this.peek()!.v === "-")) {
      const op = this.next().v;
      const r = this.term(item);
      v = op === "+" ? Number(v) + Number(r) : Number(v) - Number(r);
    }
    return v;
  }
  term(item: Item): any {
    if (this.isKw("IF_NOT_EXISTS")) {
      this.next(); this.expect("(");
      const p = this.path(); this.expect(",");
      const dflt = this.value(item); this.expect(")");
      const cur = getPath(item, p);
      return cur === undefined ? dflt : cur;
    }
    return this.operand(item);
  }
}

function getPath(item: Item | undefined, p: string[]): any {
  let cur: any = item;
  for (const s of p) { if (cur === null || typeof cur !== "object") return undefined; cur = cur[s]; }
  return cur;
}
function setPath(item: Item, p: string[], v: any): void {
  let cur: any = item;
  for (const s of p.slice(0, -1)) { if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {}; cur = cur[s]; }
  cur[p[p.length - 1]] = v;
}
function removePath(item: Item, p: string[]): void {
  let cur: any = item;
  for (const s of p.slice(0, -1)) { cur = cur?.[s]; if (!cur) return; }
  if (cur) delete cur[p[p.length - 1]];
}
function compare(a: any, op: string, b: any): boolean {
  switch (op) {
    case "=": return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
    case "<>": return JSON.stringify(a) !== JSON.stringify(b);
    case "<": return a !== undefined && a < b;
    case "<=": return a !== undefined && a <= b;
    case ">": return a !== undefined && a > b;
    case ">=": return a !== undefined && a >= b;
  }
  throw new Error(`fake-ddb 不认识的比较符 ${op}`);
}

export function evalCondition(expr: string | undefined, item: Item | undefined, names: Record<string, string> = {}, vals: Record<string, any> = {}): boolean {
  if (!expr) return true;
  const p = new Parser(lex(expr), names, vals);
  const v = p.cond(item);
  if (!p.done()) throw new Error(`fake-ddb 条件表达式没读完:${expr}`);
  return v;
}

export function applyUpdate(expr: string, item: Item, names: Record<string, string> = {}, vals: Record<string, any> = {}): void {
  const p = new Parser(lex(expr), names, vals);
  while (!p.done()) {
    const kw = p.next();
    if (kw.t !== "id") throw new Error(`fake-ddb 期望 SET/REMOVE/ADD,得到 ${kw.v}`);
    const K = kw.v.toUpperCase();
    const clauseEnd = () => p.done() || ["SET", "REMOVE", "ADD"].some((k) => p.isKw(k));
    if (K === "SET") {
      // DynamoDB 的 SET 右侧一律按**更新前**的行求值
      const snapshot = JSON.parse(JSON.stringify(item));
      for (;;) {
        const path = p.path(); p.expect("op", "=");
        setPath(item, path, p.value(snapshot));
        if (p.peek()?.t === ",") { p.next(); continue; }
        if (clauseEnd()) break;
      }
    } else if (K === "REMOVE") {
      for (;;) {
        removePath(item, p.path());
        if (p.peek()?.t === ",") { p.next(); continue; }
        if (clauseEnd()) break;
      }
    } else if (K === "ADD") {
      for (;;) {
        const path = p.path();
        const v = p.operand(item);
        const cur = getPath(item, path);
        setPath(item, path, (typeof cur === "number" ? cur : 0) + Number(v));
        if (p.peek()?.t === ",") { p.next(); continue; }
        if (clauseEnd()) break;
      }
    } else throw new Error(`fake-ddb 不认识的更新子句 ${kw.v}`);
  }
}

const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

export class FakeDdb {
  readonly tables = new Map<string, Map<string, Item>>();
  readonly calls: Array<{ op: string; table: string; input: any }> = [];
  /** 下一次对某表的某个操作直接抛(模拟 DDB 挂了) */
  failNext: { op: string; table?: string; error: Error } | null = null;
  /**
   * 不带 `Limit` 时一页多少行(真 DDB 是「1MB 一页」)。
   * 缺省 1000(与改动前逐字等价);判「翻页到底 / 翻不完就抛」的用例把它调小,让多页**真的出现**。
   */
  pageSize = 1000;
  constructor(private specs: Record<string, TableSpec>) {}

  private spec(table: string): TableSpec {
    const s = this.specs[table];
    if (!s) throw new Error(`fake-ddb 不认识的表 ${table}`);
    return s;
  }
  private keyOf(table: string, item: Item): string {
    const s = this.spec(table);
    return JSON.stringify([item[s.hash], s.range ? item[s.range] : null]);
  }
  private rows(table: string): Map<string, Item> {
    if (!this.tables.has(table)) this.tables.set(table, new Map());
    return this.tables.get(table)!;
  }
  all(table: string): Item[] { return [...this.rows(table).values()].map(clone); }
  get(table: string, key: Item): Item | undefined { return clone(this.rows(table).get(this.keyOf(table, key))); }
  put(table: string, item: Item): void { this.rows(table).set(this.keyOf(table, item), clone(item)); }

  async send(cmd: { input: any; constructor: { name: string } }): Promise<any> {
    // 让并发调用真的交错;🔴 用 setImmediate(宏任务)而不是 Promise.resolve:
    //    被测代码若陷入「每步都 continue」的死循环,只让微任务的假表会饿死事件循环 ⇒ 用例超时永远触发不了、整个进程挂住
    await new Promise<void>((r) => setImmediate(r));
    const name = cmd.constructor.name.replace(/\$\d+$/, "");
    const i = cmd.input;
    const table = String(i.TableName);
    this.calls.push({ op: name, table, input: clone(i) });
    if (this.failNext && this.failNext.op === name && (!this.failNext.table || this.failNext.table === table)) {
      const e = this.failNext.error;
      this.failNext = null;
      throw e;
    }
    const rows = this.rows(table);
    const names = i.ExpressionAttributeNames ?? {};
    const vals = i.ExpressionAttributeValues ?? {};
    switch (name) {
      case "PutCommand": {
        const k = this.keyOf(table, i.Item);
        if (!evalCondition(i.ConditionExpression, rows.get(k), names, vals)) throw new ConditionalCheckFailed();
        rows.set(k, clone(i.Item));
        return {};
      }
      case "GetCommand":
        return { Item: clone(rows.get(this.keyOf(table, i.Key))) };
      case "DeleteCommand": {
        const k = this.keyOf(table, i.Key);
        if (!evalCondition(i.ConditionExpression, rows.get(k), names, vals)) throw new ConditionalCheckFailed();
        rows.delete(k);
        return {};
      }
      case "UpdateCommand": {
        const k = this.keyOf(table, i.Key);
        const cur = rows.get(k);
        if (!evalCondition(i.ConditionExpression, cur, names, vals)) throw new ConditionalCheckFailed();
        const next = clone(cur) ?? clone(i.Key);
        applyUpdate(i.UpdateExpression, next, names, vals);
        rows.set(k, next);
        return {};
      }
      case "QueryCommand": {
        const s = this.spec(table);
        const ix = i.IndexName ? s.indexes?.[i.IndexName] : { hash: s.hash, range: s.range };
        if (!ix) throw new Error(`fake-ddb 表 ${table} 没有索引 ${i.IndexName}`);
        let items = [...rows.values()].filter((r) => r[ix.hash] !== undefined && (!ix.range || r[ix.range] !== undefined));
        items = items.filter((r) => evalCondition(i.KeyConditionExpression, r, names, vals));
        if (ix.range) {
          const rk = ix.range;
          items.sort((a, b) => (a[rk] < b[rk] ? -1 : a[rk] > b[rk] ? 1 : 0));
        }
        if (i.ScanIndexForward === false) items.reverse();
        const start = Number(i.ExclusiveStartKey?.__offset ?? 0);
        const limit = typeof i.Limit === "number" ? i.Limit : this.pageSize;
        const page = items.slice(start, start + limit);
        const more = start + limit < items.length;
        const filtered = page.filter((r) => evalCondition(i.FilterExpression, r, names, vals));
        const base = more ? { LastEvaluatedKey: { __offset: start + limit } } : {};
        if (i.Select === "COUNT") return { Count: filtered.length, ...base };
        return { Items: filtered.map(clone), Count: filtered.length, ...base };
      }
      // Scan(删项目盘点的 attr 型计数走它):过滤**在分页之后**生效、
      //   Select COUNT 只回本页过滤后的数(与真 DDB 一致 —— 不翻页就数少,判据靠它看得见)。
      case "ScanCommand": {
        const items = [...rows.values()];
        const start = Number(i.ExclusiveStartKey?.__offset ?? 0);
        const limit = typeof i.Limit === "number" ? i.Limit : this.pageSize;
        const page = items.slice(start, start + limit);
        const more = start + limit < items.length;
        const filtered = page.filter((r) => evalCondition(i.FilterExpression, r, names, vals));
        const base = more ? { LastEvaluatedKey: { __offset: start + limit } } : {};
        if (i.Select === "COUNT") return { Count: filtered.length, ...base };
        return { Items: filtered.map(clone), Count: filtered.length, ...base };
      }
    }
    throw new Error(`fake-ddb 不支持的命令 ${name}`);
  }
}

/** 本包用到的表的键形态(与 infra/lib/database-stack.ts 同源;改表结构要同步这里)。 */
export const DDB_SPECS: Record<string, TableSpec> = {
  "bgp-dataplane-jobs": {
    hash: "jobId",
    indexes: { byDue: { hash: "dueShard", range: "nextRunAt" }, byTarget: { hash: "targetId", range: "createdAt" } },
  },
  "bgp-audit": { hash: "pk", range: "ts" },
  "bgp-execution-envs": { hash: "pk", range: "sk", indexes: { byRegion: { hash: "region", range: "sk" } } },
  "bgp-sync-tasks": { hash: "userId", range: "taskId" },
  "bgp-workflows": { hash: "userId", range: "workflowId" },
  "bgp-etl-jobs": { hash: "userId", range: "jobId" },
  "bgp-engine-jobs": { hash: "userId", range: "jobId" },
  "t-sync": { hash: "userId", range: "taskId" },
  "t-wf": { hash: "userId", range: "workflowId" },
  "t-etl": { hash: "userId", range: "jobId" },
  "t-eng": { hash: "userId", range: "jobId" },
};
