// 同步任务「写哪个 S3 Tables 表桶」与「自带桶能不能写」的唯一作者 lib/sync/table-bucket.ts。
//   原形(客户 2026-10-27):非主控区任务指定自有表桶 ⇒ 启动 409,登记外部表桶后仍 409;根治 = 保存与启动同一份判定「自带桶 ∈ 本区路由 且可写」。
//   数据湖表桶路由(2026-11-04):主控区**不再**任意桶放行 —— home 与非 home 同一条规则;只读路由不能当同步目标;
//   执行区 / 主控区 Glue · EMR · Flink · Redshift-copy 角色的 s3tables 资源面统一放到「本区任意表桶」(ARN 形态唯一作者 infra/lib/shared/table-bucket-arn.ts)。
// 这组判据钉:① 纯函数边界;② 判定真读路由表(只 mock DDB 与注册表;路由作者 lib/lake/routes 走真实现);③ 三个消费点 + 两条保存路由 + infra 的接线(调用点存在,不只是 import)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

type RegRow = string | { bucket: string; writable?: boolean; alias?: string };
const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    /** 路由表(按 targetId;字符串 = 存量行(无 alias / writable,读时派生为可写)) */
    registered: new Map<string, Array<string | { bucket: string; writable?: boolean; alias?: string }>>(),
    ddb: [] as Array<{ n: string; input: Record<string, any> }>,
    targets: new Map<string, Record<string, unknown>>(),
    reset() { this.registered.clear(); this.ddb.length = 0; this.targets.clear(); },
  };
});

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings", SYNC_TASKS: "bgp-sync-tasks", EXECUTION_ENVS: "bgp-execution-envs", ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs" },
  docClient: {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      h.ddb.push({ n: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "QueryCommand" && cmd.input.TableName === "bgp-settings") {
        const prefix = String(cmd.input.ExpressionAttributeValues[":prefix"]);
        const tid = prefix.replace(/^lake-ext-bucket#/, "").replace(/#$/, "");
        return {
          Items: (h.registered.get(tid) ?? []).map((r: RegRow, i) => {
            const o = typeof r === "string" ? { bucket: r } : r;
            return { pk: "system", sk: `${prefix}${o.bucket}`, targetId: tid, bucket: o.bucket, region: tid === "tgt_home" ? "us-east-1" : "us-west-2", addedBy: "admin", addedAt: `2026-10-27T00:00:0${i}.000Z`, ...(o.alias ? { alias: o.alias } : {}), ...(o.writable === undefined ? {} : { writable: o.writable, tier: "other" }) };
          }),
        };
      }
      return {};
    },
  },
}));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = await orig<typeof import("@/lib/exec-env/registry")>();
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => h.targets.get(id) ?? null),
    requireReadyTarget: vi.fn(async (id: string) => {
      const t = h.targets.get(id);
      if (!t) throw new real.TargetNotReadyError(id, "not-registered");
      return t;
    }),
    descriptorViolation: vi.fn(() => null),
  };
});

import { resourceName } from "@/lib/aws/naming";
import { forgetLakeRoutesMemo, LakeRouteError } from "@/lib/lake/routes";
import {
  effectiveTableBucket, effectiveLakeRoute, ownTableBucketOf, tableBucketRejection, tableBucketRejectionMessage, tableBucketReadOnlyMessage, tableBucketSaveRejection, writableTableBuckets, TABLE_BUCKET_REGISTRY_PATH,
} from "../table-bucket";

const ACCOUNT = "123456789012";
const USW2 = "tgt_usw2_a";
const PLATFORM = resourceName("tableBucket", { targetId: USW2, account: ACCOUNT });
const landingUsw2 = { targetId: USW2, tableBucket: PLATFORM, home: false, region: "us-west-2" };
const landingHome = { targetId: "tgt_home", tableBucket: "bgp-table-bucket", home: true, region: "us-east-1" };

function seedUsw2Target() {
  h.targets.set(USW2, {
    targetId: USW2, region: "us-west-2", accountId: ACCOUNT, partition: "aws", status: "active", ready: true, components: ["core", "redshift"],
    resources: {
      scriptsBucket: resourceName("scriptsBucket", { targetId: USW2, account: ACCOUNT }),
      glueRoleArn: `arn:aws:iam::${ACCOUNT}:role/${resourceName("glueRole", { targetId: USW2, account: ACCOUNT })}`,
      datalakeBucket: resourceName("datalakeBucket", { targetId: USW2, account: ACCOUNT }),
      tableBucket: PLATFORM,
    },
  });
}
const settingsQueries = () => h.ddb.filter((x) => x.n === "QueryCommand" && x.input.TableName === "bgp-settings");

beforeEach(() => { h.reset(); forgetLakeRoutesMemo(); });

describe("① effectiveTableBucket / ownTableBucketOf(纯函数)", () => {
  it("自带(去空白)优先;没填 / 空白 / 非字符串 / 无 s3Config ⇒ 落点平台表桶", () => {
    expect(effectiveTableBucket({ s3Config: { tableBucket: " cust-own " } }, landingUsw2)).toBe("cust-own");
    expect(effectiveTableBucket({ s3Config: { tableBucket: "" } }, landingUsw2)).toBe(PLATFORM);
    expect(effectiveTableBucket({ s3Config: { tableBucket: "   " } }, landingUsw2)).toBe(PLATFORM);
    expect(effectiveTableBucket({ s3Config: { tableBucket: 42 } }, landingUsw2)).toBe(PLATFORM);
    expect(effectiveTableBucket({ s3Config: null }, landingUsw2)).toBe(PLATFORM);
    expect(effectiveTableBucket({}, landingHome)).toBe("bgp-table-bucket");
    expect(ownTableBucketOf({ s3Config: { tableBucket: " x " } })).toBe("x");
  });
  it("TABLE_BUCKET_REGISTRY_PATH 与路由作者的页面位置同词(拒绝文案 / 下拉提示都指它)", () => {
    expect(TABLE_BUCKET_REGISTRY_PATH).toBe("系统设置 → 数据湖表桶与路由");
  });
});

describe("② tableBucketRejection:自带桶 ∈ 本区路由且可写(路由表 fresh 直读 DDB)", () => {
  it("没自带 / 自带 == 平台表桶 ⇒ 放行且**不读**路由表", async () => {
    expect(await tableBucketRejection({}, landingUsw2)).toBeNull();
    expect(await tableBucketRejection({ s3Config: { tableBucket: PLATFORM } }, landingUsw2)).toBeNull();
    expect(settingsQueries()).toHaveLength(0);
  });

  it("🔴 主控区同一条规则(不再任意桶放行):未登记 ⇒ LAKE_ROUTE_NOT_FOUND 且读了主控区的路由表;登记为路由后 ⇒ 放行", async () => {
    expect(await tableBucketRejection({ s3Config: { tableBucket: "any-bucket-i-like" } }, landingHome)).toMatchObject({ code: "LAKE_ROUTE_NOT_FOUND" });
    expect(settingsQueries()).toHaveLength(1);
    expect(settingsQueries()[0].input.ExpressionAttributeValues[":prefix"]).toBe("lake-ext-bucket#tgt_home#");
    h.registered.set("tgt_home", ["any-bucket-i-like"]);
    expect(await tableBucketRejection({ s3Config: { tableBucket: "any-bucket-i-like" } }, landingHome)).toBeNull();
  });

  it("非主控区 + 已登记(可写)⇒ 放行(读了一次路由表,前缀 = 该执行环境)", async () => {
    h.registered.set(USW2, ["cust-own", "other-reg"]);
    expect(await tableBucketRejection({ s3Config: { tableBucket: "cust-own" } }, landingUsw2)).toBeNull();
    expect(settingsQueries()).toHaveLength(1);
    expect(settingsQueries()[0].input.ExpressionAttributeValues[":prefix"]).toBe(`lake-ext-bucket#${USW2}#`);
  });

  it("🔴 非主控区 + 未登记 ⇒ LAKE_ROUTE_NOT_FOUND,文案点名桶 / 平台表桶 / 去哪登记 / 该执行环境可写的路由清单", async () => {
    h.registered.set(USW2, ["other-reg"]);
    const r = await tableBucketRejection({ s3Config: { tableBucket: "cust-own" } }, landingUsw2);
    expect(r?.code).toBe("LAKE_ROUTE_NOT_FOUND");
    expect(r?.message).toContain(`执行环境 ${USW2} 不能写入表桶「cust-own」`);
    expect(r?.message).toContain(`平台表桶「${PLATFORM}」`);
    expect(r?.message).toContain(TABLE_BUCKET_REGISTRY_PATH);
    expect(r?.message).toContain("登记一次 = 同步可写入");
    expect(r?.message).toContain("该执行环境可写的路由:other-reg");
    expect(r?.message).toBe(tableBucketRejectionMessage("cust-own", landingUsw2, ["other-reg"]));
  });

  it("非主控区 + 未登记且该环境没有任何路由 ⇒ 文案不带「可写的路由」尾巴", async () => {
    const r = await tableBucketRejection({ s3Config: { tableBucket: "cust-own" } }, landingUsw2);
    expect(r?.message).not.toContain("可写的路由");
  });

  it("🔴 已登记但只读(writable=false)⇒ LAKE_ROUTE_NOT_WRITABLE,点名别名与桶、指路改可写;只读路由不进可写清单", async () => {
    h.registered.set(USW2, [{ bucket: "cust-ro", writable: false, alias: "ro" }, "cust-rw"]);
    const r = await tableBucketRejection({ s3Config: { tableBucket: "cust-ro" } }, landingUsw2);
    expect(r?.code).toBe("LAKE_ROUTE_NOT_WRITABLE");
    expect(r?.message).toBe(tableBucketReadOnlyMessage({ bucket: "cust-ro", alias: "ro" }, landingUsw2));
    expect(r?.message).toContain("「ro」(cust-ro)登记为只读");
    expect(r?.message).toContain(TABLE_BUCKET_REGISTRY_PATH);
    const nf = await tableBucketRejection({ s3Config: { tableBucket: "cust-nope" } }, landingUsw2);
    expect(nf?.message).toContain("该执行环境可写的路由:cust-rw"); // 只读的 cust-ro 不在清单里
    expect(await writableTableBuckets(landingUsw2)).toEqual({ platform: PLATFORM, registered: ["cust-rw"] });
  });

  it("writableTableBuckets = 平台 + 可写登记清单(存量行读时派生为可写)", async () => {
    h.registered.set(USW2, ["b1", "b2"]);
    expect(await writableTableBuckets(landingUsw2)).toEqual({ platform: PLATFORM, registered: ["b1", "b2"] });
  });
});

describe("② effectiveLakeRoute:任务真正写入的那条路由(注入 Spark 目录 / 脚本目录别名用)", () => {
  it("没自带 / 自带 == 平台表桶 ⇒ 平台路由(别名固定 s3tablescatalog,纯函数,零 DDB 读)", async () => {
    const r = await effectiveLakeRoute({}, landingUsw2);
    expect(r).toMatchObject({ platform: true, alias: "s3tablescatalog", bucket: PLATFORM, region: "us-west-2", writable: true, bucketArn: `arn:aws:s3tables:us-west-2:${ACCOUNT}:bucket/${PLATFORM}` });
    expect(await effectiveLakeRoute({ s3Config: { tableBucket: PLATFORM } }, landingUsw2)).toMatchObject({ platform: true });
    expect(settingsQueries()).toHaveLength(0);
  });
  it("自带已登记的可写桶 ⇒ 该路由(别名按桶名派生、ARN 带该区);未登记 ⇒ 抛 LAKE_ROUTE_NOT_FOUND;只读 ⇒ 抛 LAKE_ROUTE_NOT_WRITABLE", async () => {
    h.registered.set(USW2, ["cust-own", { bucket: "cust-ro", writable: false, alias: "ro" }]);
    const r = await effectiveLakeRoute({ s3Config: { tableBucket: "cust-own" } }, landingUsw2);
    expect(r).toMatchObject({ platform: false, alias: "cust_own", bucket: "cust-own", bucketArn: `arn:aws:s3tables:us-west-2:${ACCOUNT}:bucket/cust-own`, writable: true });
    await expect(effectiveLakeRoute({ s3Config: { tableBucket: "cust-nope" } }, landingUsw2)).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_FOUND", status: 400 });
    await expect(effectiveLakeRoute({ s3Config: { tableBucket: "cust-ro" } }, landingUsw2)).rejects.toBeInstanceOf(LakeRouteError);
    await expect(effectiveLakeRoute({ s3Config: { tableBucket: "cust-ro" } }, landingUsw2)).rejects.toMatchObject({ code: "LAKE_ROUTE_NOT_WRITABLE" });
  });
});

describe("② tableBucketSaveRejection:保存路由用(按任务的章解析落点)", () => {
  it("没自带 ⇒ null,零解析", async () => {
    expect(await tableBucketSaveRejection({ targets: [USW2] })).toBeNull();
    expect(h.ddb).toHaveLength(0);
  });

  it("非主控区 + 未登记 ⇒ { status: 400, code: LAKE_ROUTE_NOT_FOUND, message };已登记 ⇒ null(落点来自描述符真解析)", async () => {
    seedUsw2Target();
    const r = await tableBucketSaveRejection({ targets: [USW2], s3Config: { tableBucket: "cust-own" } });
    expect(r?.status).toBe(400);
    expect(r?.code).toBe("LAKE_ROUTE_NOT_FOUND");
    expect(r?.message).toContain(`平台表桶「${PLATFORM}」`);
    h.registered.set(USW2, ["cust-own"]);
    expect(await tableBucketSaveRejection({ targets: [USW2], s3Config: { tableBucket: "cust-own" } })).toBeNull();
  });

  it("🔴 主控区任务 + 未登记自有桶 ⇒ 400 LAKE_ROUTE_NOT_FOUND(主控区不再任意桶放行);登记为路由 ⇒ null", async () => {
    const r = await tableBucketSaveRejection({ targets: ["tgt_home"], s3Config: { tableBucket: "cust-own" } });
    expect(r).toMatchObject({ status: 400, code: "LAKE_ROUTE_NOT_FOUND" });
    expect(r?.message).toContain("执行环境 tgt_home 不能写入表桶「cust-own」");
    h.registered.set("tgt_home", ["cust-own"]);
    expect(await tableBucketSaveRejection({ targets: ["tgt_home"], s3Config: { tableBucket: "cust-own" } })).toBeNull();
  });

  it("只读路由 ⇒ 400 LAKE_ROUTE_NOT_WRITABLE(保存就拒,不等启动)", async () => {
    seedUsw2Target();
    h.registered.set(USW2, [{ bucket: "cust-ro", writable: false, alias: "ro" }]);
    expect(await tableBucketSaveRejection({ targets: [USW2], s3Config: { tableBucket: "cust-ro" } })).toMatchObject({ status: 400, code: "LAKE_ROUTE_NOT_WRITABLE" });
  });

  it("🔴 执行环境没就位(解析被拒)⇒ 400 VALIDATION_FAILED 点名执行环境与桶,不放行也不 500", async () => {
    const r = await tableBucketSaveRejection({ targets: ["tgt_nope_x"], s3Config: { tableBucket: "cust-own" } });
    expect(r).toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(r?.message).toContain("无法按执行环境 tgt_nope_x 校验 Table Bucket「cust-own」");
  });
});

// ── ③ 接线 ───────────────────────────────────────────────────────────────────
const SRC = resolve(__dirname, "../../..");
const REPO = resolve(SRC, "../..");
const codeOnly = (abs: string) =>
  readFileSync(abs, "utf8").split("\n").map((l) => {
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
    const i = l.indexOf("//");
    return i >= 0 ? l.slice(0, i) : l;
  }).join("\n");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "__tests__" && e !== "__golden__") walk(p, out); }
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("③ 接线:三个消费点 + 两条保存路由 + infra 六个栈文件", () => {
  it("start-run:写哪个桶用 effectiveTableBucket,准入调 tableBucketRejection(await),注入的目录来自 effectiveLakeRoute + sparkCatalogConf;旧的「非 home 只认描述符」判法与手写 s3tablescatalog 目录字面绝迹", () => {
    const code = codeOnly(join(SRC, "lib/sync/start-run.ts"));
    expect(code).toContain("const tableBucketName = effectiveTableBucket(task, landing);");
    expect(code).toMatch(/await tableBucketRejection\(task, landing\)/);
    expect(code).toMatch(/lakeRoute = await effectiveLakeRoute\(task, landing\)/);
    expect(code).toMatch(/sparkCatalogConf\(\[lakeRoute\], \{ engine: "glue"/);
    expect(code).not.toContain("spark.sql.catalog.s3tablescatalog=");
    expect(code).not.toMatch(/task\.s3Config\.tableBucket !== landing\.tableBucket/);
  });

  it("生成器 / 目标表守卫:同一个作者算桶;守卫探任务实际写的桶而不是 landing 的", () => {
    expect(codeOnly(join(SRC, "lib/sync/glue-script-generator.ts"))).toContain("const tableBucketName = effectiveTableBucket(task, landing);");
    const guard = codeOnly(join(SRC, "lib/sync/target-table-guard.ts"));
    expect(guard).toMatch(/probeS3Tables\(\{ region: landing\.region, tableBucket: effectiveTableBucket\(task, landing\) \}, fqs\)/);
    expect(guard).not.toMatch(/probeS3Tables\(landing, fqs\)/);
  });

  it("🔴 `s3Config?.tableBucket || landing.tableBucket` 这种各写一遍的表达式在 lib/sync 与 app/api/sync 下归零", () => {
    const files = [...walk(join(SRC, "lib/sync")), ...walk(join(SRC, "app/api/sync"))];
    const hits = files.filter((f) => /s3Config\?\.tableBucket\s*\|\|\s*landing\.tableBucket/.test(codeOnly(f))).map((f) => f.slice(SRC.length + 1));
    expect(hits).toEqual([]);
  });

  it("POST / PUT 路由:writesS3Tables 门内调 tableBucketSaveRejection(await),拒绝原样带判定的 code(LAKE_ROUTE_NOT_FOUND / NOT_WRITABLE / VALIDATION_FAILED),不再一律 VALIDATION_FAILED", () => {
    for (const rel of ["app/api/sync/route.ts", "app/api/sync/[id]/route.ts"]) {
      const code = codeOnly(join(SRC, rel));
      expect(code, rel).toMatch(/if \(writesS3Tables\((?:item|merged) as never\)\) \{\s*const bucketReject = await tableBucketSaveRejection\(/);
      expect(code, rel).toMatch(/apiError\(bucketReject\.message, bucketReject\.status, \{ code: bucketReject\.code \}\)/);
    }
  });

  it("infra:ARN 形态唯一作者 shared/table-bucket-arn.ts(bucket/*);exec-roles 的 tableBucketAnyArn 只是薄壳;core(glue / emr)/ redshift(copy)/ 主控区 EMR / 两份 Flink 栈都走它;按桶名的 tableBucketArnPair 与 bucket/<桶名> 字面绝迹", () => {
    const shared = codeOnly(join(REPO, "infra/lib/shared/table-bucket-arn.ts"));
    expect(shared).toMatch(/export function anyTableBucketArn\(partition: string, region: string, account: string\): string\[\] \{\s*return \[`arn:\$\{partition\}:s3tables:\$\{region\}:\$\{account\}:bucket\/\*`\];/);
    const roles = codeOnly(join(REPO, "infra/lib/exec-env/exec-roles.ts"));
    expect(roles).toMatch(/export function tableBucketAnyArn\(ctx: ExecEnvContext, partition: string\): string\[\] \{\s*return anyTableBucketArn\(partition, ctx\.region, ctx\.account\);/);
    expect(roles).not.toContain("tableBucketArnPair");
    const core = codeOnly(join(REPO, "infra/lib/exec-env/core-stack.ts"));
    expect(core).toContain("const tableBucketArns = tableBucketAnyArn(ctx, p);");
    expect((core.match(/actions: \["s3tables:\*"\], resources: tableBucketArns/g) || []).length).toBe(2);
    const rs = codeOnly(join(REPO, "infra/lib/exec-env/redshift-stack.ts"));
    expect(rs).toContain("resources: tableBucketAnyArn(ctx, p),");
    for (const rel of ["infra/lib/emr-stack.ts", "infra/lib/flink-stack.ts", "infra/lib/exec-env/flink-stack.ts"]) {
      const src = codeOnly(join(REPO, rel));
      expect(src, rel).toMatch(/anyTableBucketArn\(/);
      expect(src, rel).not.toMatch(/bucket\/\$\{[^}]*[tT]ableBucket/);
      expect(src, rel).not.toContain("bucket/bgp-table-bucket");
    }
    for (const f of [core, rs]) expect(f).not.toContain("tableBucketArnPair");
  });
});
