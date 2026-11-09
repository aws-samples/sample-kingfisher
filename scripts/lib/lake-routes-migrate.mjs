#!/usr/bin/env node
// scripts/lib/lake-routes-migrate.mjs —— 数据湖表桶路由(设计稿 §8 / D4)升级步 **2c‴**:
//   主控区存量同步任务写着的**未登记**自有 S3 Tables 表桶 ⇒ 自动登记为数据湖路由(别名按桶名派生、分层 other、可写、备注「auto-registered by upgrade」),
//   并以 actor=upgrade 写一条审计(lake.route.register)。幂等:已登记的秒过(条件写 attribute_not_exists(sk));表桶在该区不存在 ⇒ 只告警不登记。
//
// 【为什么要这一步】数据湖表桶路由起主控区同步任务的 Table Bucket 也必须是路由(原来主控区任意桶放行);不迁移,升级后这些任务**启动时 409
//   LAKE_ROUTE_NOT_FOUND**。运行时**不**静默自动登记(设计稿 §8:安全网 = 409 指路「去登记」)。
// 【形状】写的行与平台作者 platform/src/lib/lake/routes.ts#lakeRouteItemOf **同形**(键集 / 值形态由 golden 判据
//   platform/src/lib/lake/__tests__/migrate-script.test.ts 比对;`aliasFromBucket` 与 routes-grammar.ts 的实现逐字同、由 parity 判据钉住)。
// 【零依赖】只用 Node 内建 + `aws` CLI(与本仓其它安装 / 升级脚本同一凭证模型:`--profile`);不 import platform 的 node_modules。
//
// 用法:
//   node scripts/lib/lake-routes-migrate.mjs --profile <profile> --region <主控区> [--platform-bucket bgp-table-bucket] [--actor upgrade] [--dry-run]
//   node scripts/lib/lake-routes-migrate.mjs --profile <profile> --region <主控区> --check      # 只报告:主控区同步任务引用的未登记桶(每行一个);有 ⇒ 退 1
// 退出码:0 完成(或 --check 无未登记);1 --check 有未登记 / 迁移中有行写失败;2 入参 / aws CLI 错误。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ── 与 platform/src/lib/lake/routes-grammar.ts 逐字同的文法 / 派生(parity 判据钉住;改一处必须同改另一处)────────────
export const LAKE_ALIAS_MAX_LEN = 32;
export const LAKE_ALIAS_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const PLATFORM_ROUTE_ALIAS = "s3tablescatalog";
export const LAKE_RESERVED_ALIASES = new Set([PLATFORM_ROUTE_ALIAS, "spark_catalog", "glue_catalog", "default"]);
export const TABLE_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const HOME_TARGET_ID = "tgt_home";
export const SETTINGS_PK = "system";
export const LAKE_EXT_BUCKET_SK_PREFIX = "lake-ext-bucket#";
export const AUDIT_PK = "audit";
export const AUDIT_ACTION_REGISTER = "lake.route.register";
export const AUDIT_RESOURCE_TYPE = "s3-table-bucket";
export const MIGRATION_LABEL = "auto-registered by upgrade";

export function aliasFromBucket(bucket, taken = new Set()) {
  let base = String(bucket ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z]/.test(base)) base = `b_${base}`;
  base = base.slice(0, LAKE_ALIAS_MAX_LEN);
  const isTaken = (a) => taken.has(a) || LAKE_RESERVED_ALIASES.has(a);
  if (!isTaken(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `_${n}`;
    const cand = `${base.slice(0, LAKE_ALIAS_MAX_LEN - suffix.length)}${suffix}`;
    if (!isTaken(cand)) return cand;
  }
  throw new Error(`aliasFromBucket: 无法为表桶 ${bucket} 派生不冲突的别名`);
}

export function lakeExtBucketSk(targetId, bucket) {
  return `${LAKE_EXT_BUCKET_SK_PREFIX}${targetId}#${bucket}`;
}

// ── DynamoDB JSON ⇄ JS(aws CLI 的输入输出形态)────────────────────────────────────────────────────────────
export function toAttr(v) {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(toAttr) };
  if (typeof v === "object") return { M: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toAttr(x)])) };
  throw new Error(`toAttr: 不支持的值 ${typeof v}`);
}
export function marshal(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toAttr(x)]));
}
export function fromAttr(a) {
  if (a === null || a === undefined) return undefined;
  if ("S" in a) return a.S;
  if ("N" in a) return Number(a.N);
  if ("BOOL" in a) return a.BOOL;
  if ("NULL" in a) return null;
  if ("L" in a) return a.L.map(fromAttr);
  if ("M" in a) return unmarshal(a.M);
  if ("SS" in a) return a.SS;
  return undefined;
}
export function unmarshal(item) {
  return Object.fromEntries(Object.entries(item ?? {}).map(([k, a]) => [k, fromAttr(a)]));
}

// ── 纯函数:算出要写的行(golden 判据直接钉它)──────────────────────────────────────────────────────────────
/** 同步任务的绑定区(与 platform lib/exec-env/data-plane-target.ts#bindingTargets 同一归一口径:targets[] 优先,再 targetId,再 home)。 */
export function taskTargets(task) {
  const t = Array.isArray(task.targets) ? task.targets.filter((x) => typeof x === "string" && x) : [];
  if (t.length) return t;
  return typeof task.targetId === "string" && task.targetId ? [task.targetId] : [HOME_TARGET_ID];
}

/** 主控区同步任务引用的、不是平台表桶的自有表桶(去重;只看写 S3 Tables 的任务)。 */
export function homeOwnBuckets(tasks, platformBucket) {
  const out = [];
  for (const t of tasks) {
    if (!taskTargets(t).includes(HOME_TARGET_ID)) continue;
    const tt = String(t.targetType ?? "");
    if (tt !== "s3-tables" && tt !== "both") continue;
    const own = typeof t.s3Config?.tableBucket === "string" ? t.s3Config.tableBucket.trim() : "";
    if (!own || own === platformBucket) continue;
    if (!TABLE_BUCKET_NAME_RE.test(own)) continue; // 名字不合法的值写不进路由表(作者会拒),留给人看日志
    if (!out.includes(own)) out.push(own);
  }
  return out;
}

/**
 * 迁移计划:要写的路由行(与 platform routes.ts#lakeRouteItemOf 同形)+ 跳过原因。
 * @param args.tasks 主控区 bgp-sync-tasks 行(已 unmarshal)
 * @param args.existingRows 主控区现有路由行(已 unmarshal;只用 bucket / alias)
 * @param args.bucketExists (bucket) => boolean —— 该区真有这个表桶(aws s3tables get-table-bucket)
 */
export function planLakeRouteMigration(args) {
  const { tasks, existingRows, platformBucket, region, now, actor = "upgrade", bucketExists = () => true } = args;
  const existingBuckets = new Set(existingRows.map((r) => String(r.bucket ?? "")));
  const taken = new Set(existingRows.map((r) => String(r.alias ?? "")).filter((a) => LAKE_ALIAS_RE.test(a)));
  const items = [];
  const skipped = [];
  for (const bucket of homeOwnBuckets(tasks, platformBucket)) {
    if (existingBuckets.has(bucket)) { skipped.push({ bucket, reason: "already-registered" }); continue; }
    if (!bucketExists(bucket)) { skipped.push({ bucket, reason: "bucket-not-found" }); continue; }
    const alias = aliasFromBucket(bucket, taken);
    taken.add(alias);
    // 🔴 键集 / 顺序与 platform lakeRouteItemOf({ targetId, bucket, region, label, addedBy, addedAt, alias, tier, writable }) 同形
    items.push({
      pk: SETTINGS_PK,
      sk: lakeExtBucketSk(HOME_TARGET_ID, bucket),
      targetId: HOME_TARGET_ID,
      bucket,
      region,
      label: MIGRATION_LABEL,
      addedBy: actor,
      addedAt: now,
      alias,
      tier: "other",
      writable: true,
    });
  }
  return { items, skipped };
}

/** 审计行(与 platform lib/audit.ts#buildAuditItem 的键集同形;actor = upgrade,method / path 写脚本名)。 */
export function auditItemFor(routeItem, now, actor = "upgrade", suffix = randomSuffix()) {
  return {
    pk: AUDIT_PK,
    ts: `${now}#${suffix}`,
    targetId: routeItem.targetId,
    timestamp: now,
    actor,
    action: AUDIT_ACTION_REGISTER,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: routeItem.bucket,
    detail: { targetId: routeItem.targetId, region: routeItem.region, alias: routeItem.alias, tier: routeItem.tier, writable: routeItem.writable, label: routeItem.label, migration: "2c-triple-prime" },
    method: "",
    path: "scripts/lib/lake-routes-migrate.mjs",
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function randomSuffix(len = 26) {
  const bytes = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += CROCKFORD[bytes[i] % 32];
  return s;
}

// ── aws CLI 包装(只在真跑时用)──────────────────────────────────────────────────────────────────────────
function aws(profile, region, args) {
  const out = execFileSync("aws", [...args, "--profile", profile, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : {};
}

function scanAll(profile, region, table, projection, names) {
  const items = [];
  let token;
  do {
    const args = ["dynamodb", "scan", "--table-name", table, "--projection-expression", projection, "--expression-attribute-names", JSON.stringify(names)];
    if (token) args.push("--starting-token", token);
    const page = aws(profile, region, args);
    for (const it of page.Items ?? []) items.push(unmarshal(it));
    token = page.NextToken;
  } while (token);
  return items;
}

function queryHomeRoutes(profile, region) {
  const items = [];
  let token;
  do {
    const args = ["dynamodb", "query", "--table-name", "bgp-settings", "--key-condition-expression", "pk = :pk AND begins_with(sk, :prefix)",
      "--expression-attribute-values", JSON.stringify({ ":pk": { S: SETTINGS_PK }, ":prefix": { S: `${LAKE_EXT_BUCKET_SK_PREFIX}${HOME_TARGET_ID}#` } })];
    if (token) args.push("--starting-token", token);
    const page = aws(profile, region, args);
    for (const it of page.Items ?? []) items.push(unmarshal(it));
    token = page.NextToken;
  } while (token);
  return items;
}

function parseArgs(argv) {
  const o = { profile: "", region: "", platformBucket: "bgp-table-bucket", actor: "upgrade", dryRun: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") o.profile = argv[++i] ?? "";
    else if (a === "--region") o.region = argv[++i] ?? "";
    else if (a === "--platform-bucket") o.platformBucket = argv[++i] ?? "";
    else if (a === "--actor") o.actor = argv[++i] ?? "upgrade";
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--check") o.check = true;
    else { console.error(`未知参数 ${a}`); process.exit(2); }
  }
  if (!o.profile || !o.region) { console.error("用法:--profile <profile> --region <主控区> [--platform-bucket <桶>] [--actor upgrade] [--dry-run | --check]"); process.exit(2); }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const say = (s) => console.log(`[lake-routes-migrate] ${s}`);
  let tasks, existing, account;
  try {
    tasks = scanAll(o.profile, o.region, "bgp-sync-tasks", "taskId, #n, targets, targetId, targetType, s3Config", { "#n": "name" });
    existing = queryHomeRoutes(o.profile, o.region);
    account = String(aws(o.profile, o.region, ["sts", "get-caller-identity"]).Account ?? "");
  } catch (e) {
    console.error(`[lake-routes-migrate] aws CLI 读取失败:${String(e?.stderr || e?.message || e).slice(0, 600)}`);
    process.exit(2);
  }
  const existingBuckets = new Set(existing.map((r) => String(r.bucket ?? "")));
  const unregistered = homeOwnBuckets(tasks, o.platformBucket).filter((b) => !existingBuckets.has(b));
  if (o.check) {
    for (const b of unregistered) console.log(b);
    process.exit(unregistered.length ? 1 : 0);
  }
  say(`主控区同步任务 ${tasks.length} 条;现有路由 ${existing.length} 条;引用的未登记自有表桶 ${unregistered.length} 个`);
  const bucketExists = (bucket) => {
    try {
      aws(o.profile, o.region, ["s3tables", "get-table-bucket", "--table-bucket-arn", `arn:aws:s3tables:${o.region}:${account}:bucket/${bucket}`]);
      return true;
    } catch {
      return false;
    }
  };
  const now = new Date().toISOString();
  const plan = planLakeRouteMigration({ tasks, existingRows: existing, platformBucket: o.platformBucket, region: o.region, now, actor: o.actor, bucketExists });
  for (const s of plan.skipped) {
    if (s.reason === "bucket-not-found") say(`⚠️ 跳过 ${s.bucket}:${o.region} 里没有这个表桶(引用它的同步任务本来就跑不起来;建好桶后在「系统设置 → 数据湖表桶与路由」登记)`);
  }
  let failed = 0;
  let concurrent = 0;
  for (const item of plan.items) {
    if (o.dryRun) { say(`[dry-run] 将登记 ${item.bucket} ⇒ 别名 ${item.alias}`); continue; }
    try {
      aws(o.profile, o.region, ["dynamodb", "put-item", "--table-name", "bgp-settings", "--item", JSON.stringify(marshal(item)), "--condition-expression", "attribute_not_exists(sk)"]);
      aws(o.profile, o.region, ["dynamodb", "put-item", "--table-name", "bgp-audit", "--item", JSON.stringify(marshal(auditItemFor(item, now, o.actor)))]);
      say(`✅ 已登记 ${item.bucket} ⇒ 别名 ${item.alias}(tier other / writable;审计 actor=${o.actor})`);
    } catch (e) {
      const msg = String(e?.stderr || e?.message || e);
      if (/ConditionalCheckFailedException/.test(msg)) { concurrent += 1; say(`已登记(并发)${item.bucket},跳过`); continue; }
      failed += 1;
      console.error(`[lake-routes-migrate] ❌ 登记 ${item.bucket} 失败:${msg.slice(0, 400)}`);
    }
  }
  say(`完成:登记 ${plan.items.length - failed - concurrent} / ${plan.items.length},并发已登记 ${concurrent},跳过 ${plan.skipped.length},失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
