// 升级步 2c‴ 的数据迁移脚本 scripts/lib/lake-routes-migrate.mjs(数据湖表桶路由,设计稿 §8 / D4)—— 离线真跑替身。
//
// 【为什么要这一组】脚本只在升级机上跑一次,错了的后果是「升级后主控区写自有表桶的同步任务启动 409」或「写进路由表的行与平台作者不同形,
//   读侧再派生一遍 / 别名漂移」,而真仓库上没法反复排练。台账 infra/prod-only-layers.json 指向本文件(marker planLakeRouteMigration)。
// 【判什么】① 文法 / 派生与 lib/lake/routes-grammar.ts 逐字同(源文本 + 行为 parity);② 写的行与平台作者 registerLakeRoute 写出的 item
//   键集 / 键序 / 值同形,且被 normalizeLakeRouteItem 原样接受(derived=false);③ 审计行键集与 lib/audit.ts#buildAuditItem 同形;
//   ④ 纯函数 homeOwnBuckets / planLakeRouteMigration 的取舍;⑤ 真跑:临时目录放 Node 版假 `aws` 前置到 PATH,spawn 真 node 跑脚本,
//   钉 --check 退 1 / 0、迁移 put-item 两条 / 桶 + 条件表达式、桶不存在只告警、并发已登记退 0、--dry-run 零写、入参 / CLI 错退 2;
//   ⑥ 两处 shell 接线(redeploy-platform.sh 2c‴ / 02-postdeploy-truth.sh 第 11 条)真调它且带 --profile / --region。
// 只 mock 真外部(DDB 文档客户端 / S3 Tables 客户端 / 注册表);路由作者走真实现。
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    rows: new Map<string, Record<string, unknown>>(),
    puts: [] as Array<Record<string, any>>,
    nsByBucket: { "bgp-table-bucket": ["ods"], "cust-agg": ["agg"] } as Record<string, string[]>,
  };
});
vi.mock("@/lib/aws/clients", () => ({
  sdkClient: vi.fn(() => ({
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name;
      const bucket = String(cmd.input?.tableBucketARN ?? "").split("/").pop() ?? "";
      if (n === "GetTableBucketCommand") return { arn: cmd.input.tableBucketARN, name: bucket };
      if (n === "ListNamespacesCommand") return { namespaces: (h.nsByBucket[bucket] ?? []).map((x) => ({ namespace: [x] })) };
      return {};
    }),
  })),
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings", SYNC_TASKS: "bgp-sync-tasks", ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs", AUDIT: "bgp-audit" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = (cmd.input || {}) as Record<string, any>;
      const n = cmd.constructor.name;
      if (n === "QueryCommand") {
        const prefix = String(input.ExpressionAttributeValues[":prefix"]);
        return { Items: [...h.rows.values()].filter((r) => String(r.sk).startsWith(prefix)) };
      }
      if (n === "PutCommand") { h.puts.push(input); h.rows.set(String(input.Item.sk), input.Item); return {}; }
      if (n === "ScanCommand") return { Items: [] };
      return {};
    }),
  },
}));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", resources: { tableBucket: "bgp-table-bucket-usw2" } })) };
});

import { aliasFromBucket, LAKE_ALIAS_RE, LAKE_ALIAS_MAX_LEN, LAKE_RESERVED_ALIASES, PLATFORM_ROUTE_ALIAS, TABLE_BUCKET_NAME_RE } from "../routes-grammar";
import {
  registerLakeRoute, normalizeLakeRouteItem, lakeRouteItemOf, lakeExtBucketSk, forgetLakeRoutesMemo,
  LAKE_EXT_BUCKET_SK_PREFIX, LAKE_ROUTE_AUDIT, LAKE_ROUTE_AUDIT_RESOURCE_TYPE, type LakeRouteRow,
} from "../routes";
import { SETTINGS_PK } from "@/lib/settings/model-store";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { AUDIT_PK, buildAuditItem } from "@/lib/audit";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "lib", "lake-routes-migrate.mjs");
const mig = await import(pathToFileURL(SCRIPT).href);

const ACCT = "123456789012";
const REGION = "us-east-1";
const PLATFORM = "bgp-table-bucket";
const NOW = "2026-11-05T00:00:00.000Z";

/** 主控区 bgp-sync-tasks 夹具(与真落库同形:targets[] / 老行只有 targetId / 更老的行两者都没有)。 */
const TASKS = [
  { taskId: "t-agg-a1b2c3", name: "聚合入湖", targets: ["tgt_home"], targetType: "s3-tables", s3Config: { tableBucket: "cust-agg" } },
  { taskId: "t-ods-raw-d4e5", name: "两区都写", targets: ["tgt_home", "tgt_usw2_a"], targetType: "both", s3Config: { tableBucket: "cust-ods-raw" } },
  { taskId: "t-rs-f6g7", name: "只写数仓", targets: ["tgt_home"], targetType: "redshift", s3Config: { tableBucket: "cust-ignored" } },
  { taskId: "t-usw2-h8i9", name: "别的区", targets: ["tgt_usw2_a"], targetType: "s3-tables", s3Config: { tableBucket: "cust-other-region" } },
  { taskId: "t-platform-j1k2", name: "写平台桶", targets: ["tgt_home"], targetType: "s3-tables", s3Config: { tableBucket: PLATFORM } },
  { taskId: "t-bad-l3m4", name: "名字不合法", targets: ["tgt_home"], targetType: "s3-tables", s3Config: { tableBucket: "Bad_Bucket" } },
  { taskId: "t-agg-dup-n5p6", name: "同一桶再引用(老行只有 targetId)", targetId: "tgt_home", targetType: "s3-tables", s3Config: { tableBucket: "cust-agg" } },
  { taskId: "t-gone-q7r8", name: "桶已不在", targets: ["tgt_home"], targetType: "s3-tables", s3Config: { tableBucket: "cust-gone" } },
  { taskId: "t-reg-s9t1", name: "早已登记", targets: ["tgt_home"], targetType: "s3-tables", s3Config: { tableBucket: "cust-registered" } },
  { taskId: "t-legacy-u2v3", name: "更老的行:没有 targets 也没有 targetId", targetType: "s3-tables", s3Config: { tableBucket: "legacy-bucket" } },
  { taskId: "t-empty-w4x5", name: "空表桶", targets: ["tgt_home"], targetType: "s3-tables", s3Config: { tableBucket: "  " } },
];
/** 现有路由行:客户已登记 cust-registered,且占用了别名 cust_agg ⇒ cust-agg 派生要落到 cust_agg_2。 */
const EXISTING = [
  { pk: SETTINGS_PK, sk: `lake-ext-bucket#tgt_home#cust-registered`, targetId: "tgt_home", bucket: "cust-registered", region: REGION, label: "客户登的", addedBy: "admin", addedAt: "2026-11-01T00:00:00.000Z", alias: "cust_agg", tier: "agg", writable: true },
];
const EXPECT_UNREGISTERED = ["cust-agg", "cust-ods-raw", "cust-gone", "legacy-bucket"];

beforeEach(() => { h.rows.clear(); h.puts.length = 0; forgetLakeRoutesMemo(); });

describe("① 文法 / 派生与 routes-grammar.ts 逐字同(改一处必须同改另一处)", () => {
  it("aliasFromBucket 源文本逐字同(只允许差 TS 类型标注)", () => {
    const pick = (src: string) => {
      const m = src.match(/export function aliasFromBucket[\s\S]*?\n}\n/);
      expect(m, "找不到 aliasFromBucket 定义").toBeTruthy();
      return m![0].replace(/: ReadonlySet<string>/g, "").replace(/\(a: string\)/g, "(a)").replace(/: string/g, "");
    };
    const ts = pick(readFileSync(join(REPO, "platform/src/lib/lake/routes-grammar.ts"), "utf8"));
    const js = pick(readFileSync(SCRIPT, "utf8"));
    expect(js).toBe(ts);
  });
  it("aliasFromBucket 行为 parity:大小写 / 非法字符 / 首字符非字母 / 超长 / 保留名 / 已占用 + 截断后缀", () => {
    const takens = [new Set<string>(), new Set(["cust_agg"]), new Set(["cust_agg", "cust_agg_2"]), new Set(["x".repeat(32), `${"x".repeat(30)}_2`])];
    const buckets = ["cust-agg", "Cust-AGG", "2026-data", "a", "_x", "my.bucket-name_v2", "x".repeat(70), `abc-${"d".repeat(40)}`, "s3tablescatalog", "default", "spark-catalog", "glue-catalog"];
    for (const taken of takens) for (const b of buckets) {
      const want = aliasFromBucket(b, taken);
      expect(mig.aliasFromBucket(b, taken), `${b} / taken=${[...taken].join(",")}`).toBe(want);
      expect(want).toMatch(LAKE_ALIAS_RE);
      expect(LAKE_RESERVED_ALIASES.has(want)).toBe(false);
    }
    expect(mig.aliasFromBucket("2026-data")).toBe("b_2026_data");
    expect(mig.aliasFromBucket("s3tablescatalog")).toBe("s3tablescatalog_2");
    expect(mig.aliasFromBucket("x".repeat(70), new Set(["x".repeat(32)]))).toBe(`${"x".repeat(30)}_2`);
  });
  it("常量 parity:别名文法 / 上限 / 保留名 / 表桶名文法 / 平台别名 / 主控区 id / 设置表 pk / 路由 sk 前缀 / 审计 pk · 动作 · 资源类型", () => {
    expect(mig.LAKE_ALIAS_RE.source).toBe(LAKE_ALIAS_RE.source);
    expect(mig.LAKE_ALIAS_MAX_LEN).toBe(LAKE_ALIAS_MAX_LEN);
    expect([...mig.LAKE_RESERVED_ALIASES].sort()).toEqual([...LAKE_RESERVED_ALIASES].sort());
    expect(mig.TABLE_BUCKET_NAME_RE.source).toBe(TABLE_BUCKET_NAME_RE.source);
    expect(mig.PLATFORM_ROUTE_ALIAS).toBe(PLATFORM_ROUTE_ALIAS);
    expect(mig.HOME_TARGET_ID).toBe(HOME_TARGET_ID);
    expect(mig.SETTINGS_PK).toBe(SETTINGS_PK);
    expect(mig.LAKE_EXT_BUCKET_SK_PREFIX).toBe(LAKE_EXT_BUCKET_SK_PREFIX);
    expect(mig.lakeExtBucketSk("tgt_home", "cust-agg")).toBe(lakeExtBucketSk("tgt_home", "cust-agg"));
    expect(mig.AUDIT_PK).toBe(AUDIT_PK);
    expect(mig.AUDIT_ACTION_REGISTER).toBe(LAKE_ROUTE_AUDIT.register);
    expect(mig.AUDIT_RESOURCE_TYPE).toBe(LAKE_ROUTE_AUDIT_RESOURCE_TYPE);
  });
});

describe("② golden:迁移写的行与平台作者 registerLakeRoute 写出的 item 同形", () => {
  it("🔴 同一输入(主控区 / cust-agg / actor upgrade / 备注 / 时刻)⇒ 键集 · 键序 · 值逐一相同;平台读侧 normalizeLakeRouteItem 原样接受(derived=false)", async () => {
    await registerLakeRoute({ targetId: "tgt_home", bucket: "cust-agg", addedBy: "upgrade", label: mig.MIGRATION_LABEL, now: new Date(NOW) });
    const real = h.puts.find((p) => p.TableName === "bgp-settings")!;
    expect(real.ConditionExpression).toBe("attribute_not_exists(sk)");
    const plan = mig.planLakeRouteMigration({ tasks: [TASKS[0]], existingRows: [], platformBucket: PLATFORM, region: REGION, now: NOW, actor: "upgrade" });
    expect(plan.skipped).toEqual([]);
    expect(plan.items).toHaveLength(1);
    const mine = plan.items[0];
    expect(Object.keys(mine)).toEqual(Object.keys(real.Item));
    expect(mine).toEqual(real.Item);
    expect(mine).toEqual({ pk: "system", sk: "lake-ext-bucket#tgt_home#cust-agg", targetId: "tgt_home", bucket: "cust-agg", region: REGION, label: "auto-registered by upgrade", addedBy: "upgrade", addedAt: NOW, alias: "cust_agg", tier: "other", writable: true });
    const norm = normalizeLakeRouteItem(mine, new Set());
    expect(norm.derived).toBe(false);
    expect(lakeRouteItemOf(norm.row)).toEqual(mine);
    // DynamoDB JSON 往返(aws CLI 的输入形态)不丢键、布尔仍是布尔
    expect(mig.unmarshal(mig.marshal(mine))).toEqual(mine);
    expect(mig.marshal(mine).writable).toEqual({ BOOL: true });
    expect(mig.marshal({ a: undefined, b: null, c: [1, "x"], d: { e: false } })).toEqual({ b: { NULL: true }, c: { L: [{ N: "1" }, { S: "x" }] }, d: { M: { e: { BOOL: false } } } });
  });
  it("审计行键集与 lib/audit.ts#buildAuditItem 同形;ts = <timestamp>#<26 位 Crockford>;actor=upgrade、动作 register、资源 = 桶、detail 带 migration 标记", () => {
    const route = mig.planLakeRouteMigration({ tasks: [TASKS[0]], existingRows: [], platformBucket: PLATFORM, region: REGION, now: NOW }).items[0];
    const mine = mig.auditItemFor(route, NOW);
    const { item: real } = buildAuditItem({ actor: "upgrade" }, LAKE_ROUTE_AUDIT.register,
      { targetId: "tgt_home", resourceType: LAKE_ROUTE_AUDIT_RESOURCE_TYPE, resourceId: "cust-agg", detail: {} }, { method: "", path: "scripts/lib/lake-routes-migrate.mjs" });
    expect(Object.keys(mine)).toEqual(Object.keys(real));
    expect(mine).toMatchObject({ pk: "audit", targetId: "tgt_home", timestamp: NOW, actor: "upgrade", action: "lake.route.register", resourceType: "s3-table-bucket", resourceId: "cust-agg", method: "", path: "scripts/lib/lake-routes-migrate.mjs" });
    expect(mine.ts).toMatch(/^2026-11-05T00:00:00\.000Z#[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(String(real.ts)).toMatch(/#[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mine.detail).toEqual({ targetId: "tgt_home", region: REGION, alias: "cust_agg", tier: "other", writable: true, label: "auto-registered by upgrade", migration: "2c-triple-prime" });
    expect(mig.auditItemFor(route, NOW).ts).not.toBe(mine.ts);
  });
});

describe("③ 纯函数取舍:homeOwnBuckets / planLakeRouteMigration", () => {
  it("只看主控区 · 只看写 S3 Tables(s3-tables / both)· 去掉平台桶 / 空值 / 名字不合法 · 去重 · 老行 targetId / 无绑定按主控区;顺序 = 首次出现", () => {
    expect(mig.homeOwnBuckets(TASKS, PLATFORM)).toEqual(["cust-agg", "cust-ods-raw", "cust-gone", "cust-registered", "legacy-bucket"]);
    expect(mig.taskTargets({ targets: ["tgt_a", "", 3, "tgt_b"] })).toEqual(["tgt_a", "tgt_b"]);
    expect(mig.taskTargets({ targets: [], targetId: "tgt_x" })).toEqual(["tgt_x"]);
    expect(mig.taskTargets({})).toEqual(["tgt_home"]);
  });
  it("计划:已登记 ⇒ skipped already-registered;桶不在 ⇒ skipped bucket-not-found;别名被现有行占用 ⇒ _2;items 顺序 = 桶首次出现", () => {
    const plan = mig.planLakeRouteMigration({ tasks: TASKS, existingRows: EXISTING, platformBucket: PLATFORM, region: REGION, now: NOW, bucketExists: (b: string) => b !== "cust-gone" });
    expect(plan.skipped).toEqual([{ bucket: "cust-gone", reason: "bucket-not-found" }, { bucket: "cust-registered", reason: "already-registered" }]);
    expect(plan.items.map((i: any) => [i.bucket, i.alias, i.sk])).toEqual([
      ["cust-agg", "cust_agg_2", "lake-ext-bucket#tgt_home#cust-agg"],
      ["cust-ods-raw", "cust_ods_raw", "lake-ext-bucket#tgt_home#cust-ods-raw"],
      ["legacy-bucket", "legacy_bucket", "lake-ext-bucket#tgt_home#legacy-bucket"],
    ]);
    for (const i of plan.items) expect(i).toMatchObject({ pk: "system", targetId: "tgt_home", region: REGION, tier: "other", writable: true, addedBy: "upgrade", addedAt: NOW, label: "auto-registered by upgrade" });
    // 现有行别名不合法时不算占用(与平台读侧 normalize 的派生口径一致)
    const p2 = mig.planLakeRouteMigration({ tasks: [TASKS[0]], existingRows: [{ bucket: "zz", alias: "Not Valid" }], platformBucket: PLATFORM, region: REGION, now: NOW });
    expect(p2.items[0].alias).toBe("cust_agg");
  });
});

// ── ④ 真跑:Node 版假 aws CLI ───────────────────────────────────────────────────────────────────────────
const FAKE_AWS = `#!/usr/bin/env node
// 假 aws CLI:只认迁移脚本会发的命令;状态在 KF_FAKE_AWS_STATE(JSON),每次调用的 argv 记到 callsLog,put-item 记到 putsLog(JSONL)
const fs = require("node:fs");
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.KF_FAKE_AWS_STATE, "utf8"));
fs.appendFileSync(state.callsLog, JSON.stringify(argv) + "\\n");
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (code, msg) => { process.stderr.write(msg + "\\n"); process.exit(code); };
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); process.exit(0); };
const puts = () => fs.existsSync(state.putsLog) ? fs.readFileSync(state.putsLog, "utf8").trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const [svc, op] = argv;
if (svc === "sts" && op === "get-caller-identity") out({ UserId: "AIDAFAKEUPGRADE", Account: state.account, Arn: "arn:aws:iam::" + state.account + ":user/upgrade" });
if (svc === "dynamodb" && op === "scan") {
  if (state.failScan) fail(254, "\\nAn error occurred (AccessDeniedException) when calling the Scan operation: fake denied");
  if (opt("--table-name") !== "bgp-sync-tasks") fail(2, "fake aws: unexpected scan table " + opt("--table-name"));
  out({ Items: state.tasks, Count: state.tasks.length, ScannedCount: state.tasks.length });
}
if (svc === "dynamodb" && op === "query") {
  if (opt("--table-name") !== "bgp-settings") fail(2, "fake aws: unexpected query table " + opt("--table-name"));
  const extra = state.queryIncludesPuts ? puts().filter((p) => p.table === "bgp-settings").map((p) => p.item) : [];
  out({ Items: [...state.existingRows, ...extra] });
}
if (svc === "s3tables" && op === "get-table-bucket") {
  const arn = opt("--table-bucket-arn"); const bucket = arn.split("/").pop();
  if ((state.missingBuckets || []).includes(bucket)) fail(254, "\\nAn error occurred (NotFoundException) when calling the GetTableBucket operation: The specified bucket does not exist.");
  out({ arn, name: bucket, ownerAccountId: state.account, createdAt: "2026-01-01T00:00:00Z" });
}
if (svc === "dynamodb" && op === "put-item") {
  const table = opt("--table-name"); const item = JSON.parse(opt("--item")); const cond = opt("--condition-expression") || null;
  if (table === "bgp-settings" && cond) {
    const taken = new Set([...(state.preRegisteredSks || []), ...puts().filter((p) => p.table === "bgp-settings").map((p) => p.item.sk.S)]);
    if (taken.has(item.sk.S)) fail(254, "\\nAn error occurred (ConditionalCheckFailedException) when calling the PutItem operation: The conditional request failed");
  }
  if (table === "bgp-audit" && state.failAuditPut) fail(254, "\\nAn error occurred (ProvisionedThroughputExceededException) when calling the PutItem operation: fake");
  fs.appendFileSync(state.putsLog, JSON.stringify({ table, item, cond }) + "\\n");
  out({});
}
fail(2, "fake aws: unsupported " + argv.join(" "));
`;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function mkEnv(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kf-lake-routes-migrate-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "aws"), FAKE_AWS, { mode: 0o755 });
  const state = {
    account: ACCT, tasks: TASKS.map((t) => mig.marshal(t)), existingRows: EXISTING.map((r) => mig.marshal(r)), missingBuckets: ["cust-gone"], queryIncludesPuts: true,
    callsLog: join(dir, "calls.jsonl"), putsLog: join(dir, "puts.jsonl"), ...over,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  const env = { ...process.env, PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, KF_FAKE_AWS_STATE: join(dir, "state.json") };
  const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
  const calls = () => (existsSync(state.callsLog) ? readFileSync(state.callsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  const puts = () => (existsSync(state.putsLog) ? readFileSync(state.putsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { table: string; item: Record<string, any>; cond: string | null }) : []);
  return { run, calls, puts };
}
const BASE = ["--profile", "p", "--region", REGION];

describe("④ 真跑(Node 版假 aws 前置 PATH;凭证模型 = 每次调用都带 --profile / --region / --output json)", () => {
  it("--check:有未登记 ⇒ 退 1、stdout 每行一桶(只读:零 put-item、不探桶存在性);全登记 ⇒ 退 0、stdout 空", () => {
    const e = mkEnv();
    const r = e.run([...BASE, "--check"]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout.trim().split("\n")).toEqual(EXPECT_UNREGISTERED);
    expect(e.puts()).toEqual([]);
    expect(e.calls().map((c) => `${c[0]} ${c[1]}`)).toEqual(["dynamodb scan", "dynamodb query", "sts get-caller-identity"]);
    for (const c of e.calls()) expect(c.slice(-6)).toEqual(["--profile", "p", "--region", REGION, "--output", "json"]);
    const all = mkEnv({ existingRows: ["cust-agg", "cust-ods-raw", "cust-gone", "cust-registered", "legacy-bucket"].map((b) => mig.marshal({ ...EXISTING[0], sk: `lake-ext-bucket#tgt_home#${b}`, bucket: b, alias: b.replace(/-/g, "_") })) });
    const ok = all.run([...BASE, "--check"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe("");
  });
  it("🔴 迁移:每桶 2 条 put-item(bgp-settings 带 attribute_not_exists(sk) + bgp-audit)、行与计划同形、桶不在只告警、已登记不探桶;之后 --check 只剩不存在的那只桶", () => {
    const e = mkEnv();
    const r = e.run([...BASE, "--actor", "upgrade"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("主控区同步任务 11 条;现有路由 1 条;引用的未登记自有表桶 4 个");
    expect(r.stdout).toContain("⚠️ 跳过 cust-gone:us-east-1 里没有这个表桶");
    expect(r.stdout).toContain("✅ 已登记 cust-agg ⇒ 别名 cust_agg_2(tier other / writable;审计 actor=upgrade)");
    expect(r.stdout).toContain("完成:登记 3 / 3,并发已登记 0,跳过 2,失败 0");
    const puts = e.puts();
    const settings = puts.filter((p) => p.table === "bgp-settings");
    const audits = puts.filter((p) => p.table === "bgp-audit");
    expect(settings.map((p) => p.cond)).toEqual(["attribute_not_exists(sk)", "attribute_not_exists(sk)", "attribute_not_exists(sk)"]);
    expect(audits.map((p) => p.cond)).toEqual([null, null, null]);
    expect(puts.map((p) => p.table)).toEqual(["bgp-settings", "bgp-audit", "bgp-settings", "bgp-audit", "bgp-settings", "bgp-audit"]);
    const rows = settings.map((p) => mig.unmarshal(p.item));
    const addedAt = String(rows[0].addedAt);
    expect(addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const plan = mig.planLakeRouteMigration({ tasks: TASKS, existingRows: EXISTING, platformBucket: PLATFORM, region: REGION, now: addedAt, actor: "upgrade", bucketExists: (b: string) => b !== "cust-gone" });
    expect(rows).toEqual(plan.items);
    for (const row of rows) expect(Object.keys(row)).toEqual(["pk", "sk", "targetId", "bucket", "region", "label", "addedBy", "addedAt", "alias", "tier", "writable"]);
    const au = audits.map((p) => mig.unmarshal(p.item));
    expect(au.map((a) => [a.action, a.actor, a.resourceType, a.resourceId, a.targetId, a.timestamp])).toEqual(plan.items.map((i: any) => ["lake.route.register", "upgrade", "s3-table-bucket", i.bucket, "tgt_home", addedAt]));
    expect(au.map((a) => a.detail.alias)).toEqual(["cust_agg_2", "cust_ods_raw", "legacy_bucket"]);
    const probes = e.calls().filter((c) => c[0] === "s3tables").map((c) => c[c.indexOf("--table-bucket-arn") + 1]);
    expect(probes).toEqual(["cust-agg", "cust-ods-raw", "cust-gone", "legacy-bucket"].map((b) => `arn:aws:s3tables:${REGION}:${ACCT}:bucket/${b}`));
    for (const c of e.calls()) expect(c.slice(-6)).toEqual(["--profile", "p", "--region", REGION, "--output", "json"]);
    const chk = e.run([...BASE, "--check"]);
    expect(chk.status).toBe(1);
    expect(chk.stdout.trim()).toBe("cust-gone");
    // 第二跑幂等:路由表已有 ⇒ 未登记只剩 cust-gone,零新写
    const again = e.run(BASE);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("引用的未登记自有表桶 1 个");
    expect(again.stdout).toContain("完成:登记 0 / 0,并发已登记 0,跳过 5,失败 0"); // 3 只刚登记的 + 1 早已登记 + 1 桶不在
    expect(e.puts()).toHaveLength(6);
  });
  it("并发已登记(条件写被拒)⇒ 只记「已登记(并发)」、不写审计、退 0;审计写失败 ⇒ 退 1 并 stderr ❌;--dry-run ⇒ 零 put-item、退 0", () => {
    const c = mkEnv({ queryIncludesPuts: false, preRegisteredSks: ["lake-ext-bucket#tgt_home#cust-agg"] });
    const r = c.run(BASE);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("已登记(并发)cust-agg,跳过");
    expect(r.stdout).toContain("完成:登记 2 / 3,并发已登记 1,跳过 2,失败 0");
    expect(c.puts().map((p) => `${p.table}:${mig.unmarshal(p.item).bucket ?? mig.unmarshal(p.item).resourceId}`)).toEqual(["bgp-settings:cust-ods-raw", "bgp-audit:cust-ods-raw", "bgp-settings:legacy-bucket", "bgp-audit:legacy-bucket"]);
    const f = mkEnv({ failAuditPut: true });
    const rf = f.run(BASE);
    expect(rf.status).toBe(1);
    expect(rf.stderr).toContain("❌ 登记 cust-agg 失败");
    expect(rf.stdout).toContain("完成:登记 0 / 3,并发已登记 0,跳过 2,失败 3");
    const d = mkEnv();
    const rd = d.run([...BASE, "--dry-run"]);
    expect(rd.status, rd.stderr).toBe(0);
    expect(rd.stdout).toContain("[dry-run] 将登记 cust-agg ⇒ 别名 cust_agg_2");
    expect(rd.stdout).toContain("[dry-run] 将登记 legacy-bucket ⇒ 别名 legacy_bucket");
    expect(d.puts()).toEqual([]);
    expect(d.calls().filter((x) => x[1] === "put-item")).toEqual([]);
  });
  it("入参错 ⇒ 退 2(缺 --profile / --region 打印用法;未知参数点名);aws CLI 读不到 ⇒ 退 2 且 stderr 原话", () => {
    const e = mkEnv();
    const r0 = e.run([]);
    expect(r0.status).toBe(2);
    expect(r0.stderr).toContain("用法:--profile <profile> --region <主控区>");
    const r1 = e.run(["--profile", "p"]);
    expect(r1.status).toBe(2);
    const r2 = e.run([...BASE, "--bogus"]);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain("未知参数 --bogus");
    expect(e.calls()).toEqual([]);
    const f = mkEnv({ failScan: true });
    const r3 = f.run([...BASE, "--check"]);
    expect(r3.status).toBe(2);
    expect(r3.stderr).toContain("aws CLI 读取失败");
    expect(r3.stderr).toContain("AccessDeniedException");
    expect(f.puts()).toEqual([]);
  });
});

describe("⑤ 接线:两处 shell 真调它(「写了」≠「接上了」)", () => {
  it("redeploy-platform.sh 2c‴ 步在平台栈之前 node 调脚本、带 --profile / --region / --actor upgrade,失败 die;02-postdeploy-truth.sh 第 11 条用 --check 并按退出码 0 / 1 / 其它三态判", () => {
    const rp = readFileSync(join(REPO, "scripts/redeploy-platform.sh"), "utf8");
    expect(rp).toMatch(/node "\$HERE\/lib\/lake-routes-migrate\.mjs" --profile "\$PROFILE" --region "\$REGION" --actor upgrade \\\n\s+\|\| die "/);
    expect(rp.indexOf('node "$HERE/lib/lake-routes-migrate.mjs"')).toBeLessThan(rp.indexOf("npx cdk deploy BgpPlatformStack --require-approval never"));
    const truth = readFileSync(join(REPO, "scripts/02-postdeploy-truth.sh"), "utf8");
    expect(truth).toMatch(/UNREG=\$\(node "\$HERE\/lib\/lake-routes-migrate\.mjs" --profile "\$PROFILE" --region "\$REGION" --check 2>[^)]+\); RC=\$\?/);
    expect(truth).toMatch(/case "\$RC" in\s*\n\s*0\) ok /);
    expect(truth).toMatch(/\n\s*1\) bad "主控区同步任务引用了未登记的自有表桶/);
    expect(truth).toMatch(/\n\s*\*\) bad "读不到同步任务 \/ 路由表/);
    const ledger = JSON.parse(readFileSync(join(REPO, "infra/prod-only-layers.json"), "utf8")) as { layers: Array<{ id: string; harness?: { where: string; marker: string } }> };
    const layer = ledger.layers.find((l) => l.id === "script:lib/lake-routes-migrate.mjs");
    expect(layer?.harness).toMatchObject({ where: "platform/src/lib/lake/__tests__/migrate-script.test.ts", marker: "planLakeRouteMigration" });
  });
});
