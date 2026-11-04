// 🔴 非主控区执行环境的同步任务指定自有 S3 Tables 表桶 ⇒ 启动 409(登记外部表桶后仍 409)。
//   根治 = lib/sync/table-bucket.ts 唯一作者:「写哪个桶」三处共用 + 「自带桶能不能写」= 平台表桶 ∪ 登记表,保存与启动同一份判定;
//   执行区 Glue / EMR / Redshift-copy 角色的 s3tables 资源面放到同区任意表桶。
// 这组判据钉:① 纯函数边界;② 判定真读登记表(只 mock DDB 与注册表);③ 三个消费点 + 两条保存路由 + infra 三个栈的接线(调用点存在,不只是 import)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    /** 登记表(按 targetId) */
    registered: new Map<string, string[]>(),
    ddb: [] as Array<{ n: string; input: Record<string, any> }>,
    targets: new Map<string, Record<string, unknown>>(),
    reset() { this.registered.clear(); this.ddb.length = 0; this.targets.clear(); },
  };
});

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings", SYNC_TASKS: "bgp-sync-tasks", EXECUTION_ENVS: "bgp-execution-envs" },
  docClient: {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      h.ddb.push({ n: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "QueryCommand" && cmd.input.TableName === "bgp-settings") {
        const prefix = String(cmd.input.ExpressionAttributeValues[":prefix"]);
        const tid = prefix.replace(/^lake-ext-bucket#/, "").replace(/#$/, "");
        return { Items: (h.registered.get(tid) ?? []).map((b, i) => ({ pk: "settings", sk: `${prefix}${b}`, targetId: tid, bucket: b, region: "us-west-2", addedBy: "admin", addedAt: `2026-10-27T00:00:0${i}.000Z` })) };
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
import {
  effectiveTableBucket, ownTableBucketOf, tableBucketRejection, tableBucketRejectionMessage, tableBucketSaveRejection, writableTableBuckets, TABLE_BUCKET_REGISTRY_PATH,
} from "../table-bucket";

const ACCOUNT = "123456789012";
const USW2 = "tgt_usw2_a";
const PLATFORM = resourceName("tableBucket", { targetId: USW2, account: ACCOUNT });
const landingUsw2 = { targetId: USW2, tableBucket: PLATFORM, home: false };
const landingHome = { targetId: "tgt_home", tableBucket: "bgp-table-bucket", home: true };

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

beforeEach(() => h.reset());

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
});

describe("② tableBucketRejection:平台表桶 ∪ 登记表(登记表直读 DDB)", () => {
  it("没自带 / 自带 == 平台表桶 ⇒ 放行且**不读**登记表", async () => {
    expect(await tableBucketRejection({}, landingUsw2)).toBeNull();
    expect(await tableBucketRejection({ s3Config: { tableBucket: PLATFORM } }, landingUsw2)).toBeNull();
    expect(settingsQueries()).toHaveLength(0);
  });

  it("主控区 ⇒ 任意自带桶放行(行为不变),不读登记表", async () => {
    expect(await tableBucketRejection({ s3Config: { tableBucket: "any-bucket-i-like" } }, landingHome)).toBeNull();
    expect(settingsQueries()).toHaveLength(0);
  });

  it("非主控区 + 已登记 ⇒ 放行(读了一次登记表,前缀 = 该执行环境)", async () => {
    h.registered.set(USW2, ["cust-own", "other-reg"]);
    expect(await tableBucketRejection({ s3Config: { tableBucket: "cust-own" } }, landingUsw2)).toBeNull();
    expect(settingsQueries()).toHaveLength(1);
    expect(settingsQueries()[0].input.ExpressionAttributeValues[":prefix"]).toBe(`lake-ext-bucket#${USW2}#`);
  });

  it("🔴 非主控区 + 未登记 ⇒ 拒绝文案:点名桶 / 平台表桶 / 去哪登记 / 已登记可用清单", async () => {
    h.registered.set(USW2, ["other-reg"]);
    const msg = await tableBucketRejection({ s3Config: { tableBucket: "cust-own" } }, landingUsw2);
    expect(msg).toBeTruthy();
    expect(msg).toContain(`执行环境 ${USW2} 不能写入表桶「cust-own」`);
    expect(msg).toContain(`平台表桶「${PLATFORM}」`);
    expect(msg).toContain(TABLE_BUCKET_REGISTRY_PATH);
    expect(msg).toContain("登记一次 = 同步可写入");
    expect(msg).toContain("已登记可用:other-reg");
    expect(msg).toBe(tableBucketRejectionMessage("cust-own", landingUsw2, ["other-reg"]));
  });

  it("非主控区 + 未登记且该环境没有任何登记 ⇒ 文案不带「已登记可用」尾巴", async () => {
    const msg = await tableBucketRejection({ s3Config: { tableBucket: "cust-own" } }, landingUsw2);
    expect(msg).not.toContain("已登记可用");
  });

  it("writableTableBuckets = 平台 + 登记清单", async () => {
    h.registered.set(USW2, ["b1", "b2"]);
    expect(await writableTableBuckets(landingUsw2)).toEqual({ platform: PLATFORM, registered: ["b1", "b2"] });
  });
});

describe("② tableBucketSaveRejection:保存路由用(按任务的章解析落点)", () => {
  it("没自带 ⇒ null,零解析", async () => {
    expect(await tableBucketSaveRejection({ targets: [USW2] })).toBeNull();
    expect(h.ddb).toHaveLength(0);
  });

  it("非主控区 + 未登记 ⇒ { status: 400, message };已登记 ⇒ null(落点来自描述符真解析)", async () => {
    seedUsw2Target();
    const r = await tableBucketSaveRejection({ targets: [USW2], s3Config: { tableBucket: "cust-own" } });
    expect(r?.status).toBe(400);
    expect(r?.message).toContain(`平台表桶「${PLATFORM}」`);
    h.registered.set(USW2, ["cust-own"]);
    expect(await tableBucketSaveRejection({ targets: [USW2], s3Config: { tableBucket: "cust-own" } })).toBeNull();
  });

  it("主控区任务 ⇒ null(任意自带桶)", async () => {
    expect(await tableBucketSaveRejection({ targets: ["tgt_home"], s3Config: { tableBucket: "cust-own" } })).toBeNull();
  });

  it("🔴 执行环境没就位(解析被拒)⇒ 400 点名执行环境与桶,不放行也不 500", async () => {
    const r = await tableBucketSaveRejection({ targets: ["tgt_nope_x"], s3Config: { tableBucket: "cust-own" } });
    expect(r?.status).toBe(400);
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

describe("③ 接线:三个消费点 + 两条保存路由 + infra 三个栈", () => {
  it("start-run:写哪个桶用 effectiveTableBucket,准入调 tableBucketRejection(await),旧的「非 home 只认描述符」判法绝迹", () => {
    const code = codeOnly(join(SRC, "lib/sync/start-run.ts"));
    expect(code).toContain("const tableBucketName = effectiveTableBucket(task, landing);");
    expect(code).toMatch(/await tableBucketRejection\(task, landing\)/);
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

  it("POST / PUT 路由:writesS3Tables 门内调 tableBucketSaveRejection(await),拒绝回 VALIDATION_FAILED", () => {
    for (const rel of ["app/api/sync/route.ts", "app/api/sync/[id]/route.ts"]) {
      const code = codeOnly(join(SRC, rel));
      expect(code, rel).toMatch(/if \(writesS3Tables\((?:item|merged) as never\)\) \{\s*const bucketReject = await tableBucketSaveRejection\(/);
      expect(code, rel).toMatch(/apiError\(bucketReject\.message, bucketReject\.status, \{ code: "VALIDATION_FAILED" \}\)/);
    }
  });

  it("infra:core(glue / emr)与 redshift(copy)三处 s3tables 资源 = 本区任意表桶 `bucket/*`;按桶名的 tableBucketArnPair 绝迹", () => {
    const roles = codeOnly(join(REPO, "infra/lib/exec-env/exec-roles.ts"));
    expect(roles).toMatch(/export function tableBucketAnyArn\(ctx: ExecEnvContext, partition: string\): string\[\] \{\s*return \[`arn:\$\{partition\}:s3tables:\$\{ctx\.region\}:\$\{ctx\.account\}:bucket\/\*`\];/);
    expect(roles).not.toContain("tableBucketArnPair");
    const core = codeOnly(join(REPO, "infra/lib/exec-env/core-stack.ts"));
    expect(core).toContain("const tableBucketArns = tableBucketAnyArn(ctx, p);");
    expect((core.match(/actions: \["s3tables:\*"\], resources: tableBucketArns/g) || []).length).toBe(2);
    const rs = codeOnly(join(REPO, "infra/lib/exec-env/redshift-stack.ts"));
    expect(rs).toContain("resources: tableBucketAnyArn(ctx, p),");
    for (const f of [core, rs]) expect(f).not.toContain("tableBucketArnPair");
  });
});
