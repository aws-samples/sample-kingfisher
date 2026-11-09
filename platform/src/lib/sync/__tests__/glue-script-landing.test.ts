// 钉两件事(合同 ④-2 的「home 等价单测 + 变异验红」):
//   ① **home 逐字节等价**:注入进脚本的每个落点值 == 改造前的字面量/表达式,逐项相等
//      (region=env / staging=bgp-datalake-<acct> / 表桶=bgp-table-bucket / 库=x||dev);
//   ② **判别力**(第十五段教训:现网数据让对错两种实现同结果 ⇒ 必须造判别夹具):
//      非 home 的 binding 喂进去,脚本里出现的必须是**那个区**的值,且 home 的值一个都不出现
//      (双向);home 命名的运行期探名(describe_secret)与按账号拼桶(get_caller_identity)已退役。
// 🔴 负向文本断言先按行剥注释(本仓红线):防止注释里提到旧写法造成假红/假绿。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { generateGlueScript, type GlueScriptBindings } from "@/lib/sync/glue-script-generator";
import { resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { resolveWorkgroup, resolveDatabase } from "@/lib/redshift/warehouse-location";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import type { DataSource } from "@/types/datasource";

const ENV_KEYS = [
  "AWS_REGION", "AWS_ACCOUNT_ID", "GLUE_SCRIPTS_BUCKET", "EMR_LOG_BUCKET",
  "S3TABLES_BUCKET", "GLUE_ROLE_ARN", "REDSHIFT_WORKGROUP", "REDSHIFT_DATABASE",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  // 兜底链走「命名 SSOT」那一层 = 改造前字面量的形状(infra 实际也把它们配成同值)。
  delete process.env.GLUE_SCRIPTS_BUCKET;
  delete process.env.EMR_LOG_BUCKET;
  delete process.env.S3TABLES_BUCKET;
  delete process.env.REDSHIFT_WORKGROUP;
  delete process.env.REDSHIFT_DATABASE;
});

/**
 * 数仓四样以 PlaceWire 进脚本(`_BGP_PLACE = bgp_read_place("<json>")`)。
 * 抠出那段 JSON 解析成对象再比值;读取方式另由下面的接线断言钉(rs_client / rs_workgroup / … 都必须从它取)。
 */
function rsPlaceOf(script: string): { targetId: string; region: string; redshift?: { workgroup: string; database: string; secretArn?: string } } {
  const m = /^_BGP_PLACE = bgp_read_place\(("(?:[^"\\]|\\.)*")\)$/m.exec(script);
  if (!m) throw new Error("脚本里没有 _BGP_PLACE = bgp_read_place(...) —— 数仓落点没以 PlaceWire 进脚本");
  return JSON.parse(JSON.parse(m[1]));
}
function expectReadsFromPlace(script: string): void {
  expect(script).toContain('rs_client = boto3.client("redshift-data", region_name=_BGP_PLACE["region"])');
  expect(script).toContain('boto3.client("redshift-serverless", region_name=_BGP_PLACE["region"])');
  expect(script).toContain('rs_workgroup = _BGP_RS["workgroup"]');
  expect(script).toContain('rs_database = _BGP_RS["database"]');
  expect(script).toContain('RS_ADMIN_SECRET_ARN = _BGP_RS.get("secretArn")');
  expect(script).toContain('_BGP_RS = bgp_place_leg(_BGP_PLACE, "redshift")');
  expect(script).toContain("def bgp_read_place(raw):");
}

/** 负向断言用:剥掉 Python 整行注释(负向文本断言按行剥注释的仓规)。 */
function codeOnly(script: string): string {
  return script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
}

// jdbc 形态但不落任何真实 SPI(未知类型 ⇒ jdbcUrl 空串、走 Secrets Manager 读源密钥的分支)。
const jdbcDs = {
  datasourceId: "ds_jdbc", name: "src", type: "x-fixture",
  secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:src-AbC",
  database: "gamedb",
} as unknown as DataSource;

const baseTask = {
  taskId: "t_fixture_0001", targetType: "both",
  sourceDatabase: "gamedb", sourceTables: ["players"],
  s3Config: { namespace: "gamedb" }, redshiftConfig: { schema: "public" },
  syncMode: "full", writeMode: "overwrite",
};

const HOME_ADMIN_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift!bgp-namespace-admin-AbCdEf";

async function homeBindings(secretArn?: string | null): Promise<GlueScriptBindings> {
  // landing 走**路由同一条路**(resolveGlueBinding 的 home 路径,纯 env,不碰 AWS);
  // rsb 的 home 值由 resolveRedshiftBinding 的 home 分支产出,但那条分支要真调 Secrets Manager,
  // 单测里按它的定义逐项手排(region=env、workgroup/database=warehouse-location 同一作者)。
  const landing = await resolveGlueBinding({ targetId: HOME_TARGET_ID });
  return {
    landing,
    lakeCatalogAlias: "s3tablescatalog", // 数据湖表桶路由:平台路由的固定别名(脚本与改动前逐字相同)
    rsb: {
      region: process.env.AWS_REGION || "us-east-1",
      workgroup: resolveWorkgroup(undefined),
      database: resolveDatabase(undefined),
      secretArn,
    },
  };
}

describe("home 注入值 == 改造前字面量,逐项相等", () => {
  it("home landing 三样与旧字面量逐字相等(staging 桶 / 表桶 / region)", async () => {
    const { landing } = await homeBindings();
    // 改造前:secretsmanager/redshift-data 客户端 region = process.env.AWS_REGION || "us-east-1"
    expect(landing.region).toBe("us-east-1");
    // 改造前:staging = f"s3://bgp-datalake-{account_id}/..."(运行期 STS 拿账号)
    expect(landing.datalakeBucket).toBe("bgp-datalake-123456789012");
    // 改造前:tableBucketName 兜底字面量 "bgp-table-bucket"
    expect(landing.tableBucket).toBe("bgp-table-bucket");
  });

  it("home 数仓两样与旧表达式等价(workgroup 同一作者;database x||dev)", () => {
    // 改造前脚本里 rs_workgroup = resolveWorkgroup(task.redshiftConfig?.workgroupName) —— 同一作者;
    // rs_database = task.redshiftConfig?.database || "dev" —— resolveDatabase 必须与它同值。
    expect(resolveDatabase(undefined)).toBe("dev");
    expect(resolveDatabase("mydb")).toBe("mydb");
    expect(resolveWorkgroup("custom-wg")).toBe("custom-wg");
  });

  it("home 脚本的每个注入点值与改造前一致(区/workgroup/库/staging/表桶/凭证)", async () => {
    const b = await homeBindings(HOME_ADMIN_ARN);
    const script = generateGlueScript(baseTask, jdbcDs, b);
    expect(script).toContain('sm = boto3.client("secretsmanager", region_name="us-east-1")');
    expectReadsFromPlace(script);
    expect(rsPlaceOf(script)).toEqual({
      v: 1, targetId: HOME_TARGET_ID, region: "us-east-1",
      redshift: { workgroup: resolveWorkgroup(undefined), database: "dev", secretArn: HOME_ADMIN_ARN },
    });
    expect(script).toContain("s3://bgp-datalake-123456789012/sync-staging/");
    expect(script).toContain('S3T_BUCKET_RAW = "bgp-table-bucket"');
  });

  it("无密钥裸环境(secretArn undefined)⇒ RS_ADMIN_SECRET_ARN = None(旧「探不到回 IAM」语义)", async () => {
    const b = await homeBindings(undefined);
    const script = generateGlueScript(baseTask, jdbcDs, b);
    // 落点里没有 secretArn ⇒ `_BGP_RS.get("secretArn")` 读到 None(与旧字面量 None 同值)
    expect(rsPlaceOf(script).redshift).toEqual({ workgroup: resolveWorkgroup(undefined), database: "dev" });
    expect(script).toContain('RS_ADMIN_SECRET_ARN = _BGP_RS.get("secretArn")');
  });
});

// ── 判别夹具:非 home 的 binding ⇒ 脚本全是该区的值,home 的值零出现 ─────────────
const usw2: GlueScriptBindings = {
  landing: {
    targetId: "tgt_usw2_a",
    region: "us-west-2",
    datalakeBucket: "bgp-datalake-123456789012-usw2a",
    tableBucket: "bgp-table-bucket-usw2a",
  },
  lakeCatalogAlias: "s3tablescatalog",
  rsb: {
    region: "us-west-2",
    workgroup: "bgp-exec-usw2a-wg",
    database: "devwest",
    secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:bgp-exec-usw2a-admin-XyZ",
  },
};

describe("非 home binding 的判别力(双向)", () => {
  it("正向:脚本里的六个落点全是 usw2 的值", () => {
    const script = generateGlueScript(baseTask, jdbcDs, usw2);
    expect(script).toContain('sm = boto3.client("secretsmanager", region_name="us-west-2")');
    expectReadsFromPlace(script);
    expect(rsPlaceOf(script)).toEqual({
      v: 1, targetId: "tgt_usw2_a", region: "us-west-2",
      redshift: { workgroup: "bgp-exec-usw2a-wg", database: "devwest", secretArn: usw2.rsb!.secretArn },
    });
    expect(script).toContain("s3://bgp-datalake-123456789012-usw2a/sync-staging/");
    expect(script).toContain('S3T_BUCKET_RAW = "bgp-table-bucket-usw2a"');
  });

  it("负向:home 的值与已退役写法零出现(剥注释后判)", () => {
    const code = codeOnly(generateGlueScript(baseTask, jdbcDs, usw2));
    // 若 generator 任何一处又偷偷回落 env(AWS_REGION=us-east-1 在本测试里就是 home),这里当场红。
    expect(code).not.toContain("us-east-1");
    // home 命名的运行期探名 / 按运行期账号拼 staging 桶,两个旧写法都已退役。
    expect(code).not.toContain("describe_secret");
    expect(code).not.toContain("get_caller_identity");
    expect(code).not.toContain("bgp-datalake-{account_id}");
    // home 的表桶字面量不许再出现在非 home 脚本里。
    expect(code).not.toContain('"bgp-table-bucket"');
  });

  it("DDB 源缺省区 = 落点区(旧 env 回落退役)", () => {
    const ddbDs = {
      datasourceId: "ds_ddb", name: "ddb", type: "dynamodb",
      connection: { tableName: "orders" },
    } as unknown as DataSource;
    const script = generateGlueScript({ ...baseTask, targetType: "s3-tables" }, ddbDs, { ...usw2, rsb: null });
    expect(script).toContain('DDB_REGION = "us-west-2"');
  });

  it("写 Redshift 却没给 rsb ⇒ 当场拒(禁静默回落 home / env)", () => {
    expect(() => generateGlueScript(baseTask, jdbcDs, { landing: usw2.landing, rsb: null, lakeCatalogAlias: "s3tablescatalog" })).toThrow(/rsb/);
    // 不写 Redshift 的任务不需要 rsb(用不上的字段不逼调用方造)。
    expect(() =>
      generateGlueScript({ ...baseTask, targetType: "s3-tables" }, jdbcDs, { landing: usw2.landing, rsb: null, lakeCatalogAlias: "s3tablescatalog" })
    ).not.toThrow();
  });
});
