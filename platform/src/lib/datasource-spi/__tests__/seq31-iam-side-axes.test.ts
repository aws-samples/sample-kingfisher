// 序 31 三刀 IAM 侧(2026-10-21)—— …9435 observe 第四十四轮 `place.creds.denied` 量出的四族缺口,产品侧两处改轴 + 一处删死请求,
//   加数据面角色策略(infra)补三族写 / 列权限。本文件钉**事实**(调用点在、轴对、区从 ARN 派生、角色资源面齐),不钉形态。
//   缺口清单(主控区数据面角色,04:50–06:55Z):s3:ListAllMyBuckets ×20 · bgp/datasource/* Create ×11 / Delete ×13 / Update ×1 ·
//   bgp/dms/redshift-target PutSecretValue ×1 · 账号自有 RDS 主密钥 GetSecretValue ×3。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 行为判据:账号自有密钥读点走控制面轴、region 从 ARN 派生 ─────────────────────────────
// 只 mock 真外部 = AWS 客户端工厂的两个入口(sdkClient / regionalClient),其余导出保持真实(兄弟模块 target-clients 不 mock)。
const seen: Array<{ use: string; ctor: string; opts: Record<string, unknown> }> = [];
vi.mock("@/lib/aws/clients", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sdkClient: (use: string, Ctor: { name: string }, opts: Record<string, unknown>) => {
    seen.push({ use, ctor: Ctor.name, opts });
    return { send: async (cmd: { input: { SecretId: string } }) => ({ SecretString: JSON.stringify({ username: "u-" + cmd.input.SecretId.slice(-6), password: "p" }) }) };
  },
  regionalClient: async () => { throw new Error("控制面读点不该走数据面工厂 regionalClient"); },
}));

describe("序 31 三刀 IAM 侧 ① 账号自有 RDS 主密钥读点 getAccountSecretViaControlPlane", () => {
  beforeEach(() => { seen.length = 0; });

  it("走控制面轴(sdkClient use=control-plane)、客户端是 SecretsManagerClient、region 从 ARN 派生而不是主控区", async () => {
    const { getAccountSecretViaControlPlane } = await import("@/lib/datasource-spi/secrets");
    const arn = "arn:aws:secretsmanager:eu-central-1:123456789abc:secret:rds!db-01EXAMPLE-AbCdEf";
    const got = await getAccountSecretViaControlPlane(arn);
    expect(got).toEqual({ username: "u-AbCdEf", password: "p" });
    expect(seen).toHaveLength(1);
    expect(seen[0].use).toBe("control-plane");
    expect(seen[0].ctor).toBe("SecretsManagerClient");
    expect(seen[0].opts).toEqual({ region: "eu-central-1" });
  });

  it("ARN 里解析不出 region 就抛(刻意不回落主控区),不发任何调用", async () => {
    const { getAccountSecretViaControlPlane } = await import("@/lib/datasource-spi/secrets");
    await expect(getAccountSecretViaControlPlane("not-an-arn")).rejects.toThrow(/解析不出 region/);
    expect(seen).toHaveLength(0);
  });
});

// ── 接缝判据:调用点存在(「写了」≠「接上了」,纪律 5)─────────────────────────────────────
describe("序 31 三刀 IAM 侧 ② 调用点与轴", () => {
  it("建源路由对 rdsSecretArn 用的是 getAccountSecretViaControlPlane,不再是数据面的 getSecret", () => {
    const src = stripComments(read("platform/src/app/api/datasources/route.ts"));
    expect(src).toMatch(/getAccountSecretViaControlPlane\(rdsSecretArn\)/);
    expect(src).not.toMatch(/getSecret\(rdsSecretArn\)/);
    expect(src).toMatch(/import\("@\/lib\/datasource-spi\/secrets"\)/);
  });

  it("桶清单路由 /api/s3/buckets 走控制面轴(账号级清点),不再是数据面轴", () => {
    const src = stripComments(read("platform/src/app/api/s3/buckets/route.ts"));
    expect(src).toMatch(/sdkClient\("control-plane",\s*S3Client/);
    expect(src).not.toMatch(/sdkClient\("data-plane"/);
    expect(src).toMatch(/ListBucketsCommand/);
  });

  it("同步向导不再发 /api/s3/buckets 的死请求(此前有状态无消费);系统设置「服务状态」仍是它唯一消费点", () => {
    const wizard = stripComments(read("platform/src/app/sync/SyncTaskModal.tsx"));
    expect(wizard).not.toContain("/api/s3/buckets");
    expect(wizard).not.toMatch(/\bs3Buckets\b/);
    const settings = stripComments(read("platform/src/app/settings/page.tsx"));
    expect(settings).toContain('fetch("/api/s3/buckets")');
  });
});

// ── 基础设施判据:数据面角色(唯一作者)资源面与清单同笔补齐 ────────────────────────────────
describe("序 31 三刀 IAM 侧 ③ 数据面角色唯一作者 infra/lib/shared/platform-data-role.ts", () => {
  const src = stripComments(read("infra/lib/shared/platform-data-role.ts"));
  const stmt = (sid: string) => {
    const at = src.indexOf(`sid: "${sid}"`);
    expect(at, `找不到语句 ${sid}`).toBeGreaterThan(0);
    return src.slice(at, src.indexOf("})", at));
  };

  it("写语句 OwnRegionCredentialSecretsWrite 的资源面含 bgp/datasource/* 与 bgp/dms/*(之前只有 project / shared-writer)", () => {
    const w = stmt("OwnRegionCredentialSecretsWrite");
    for (const face of ['sec("bgp/datasource/*")', 'sec("bgp/dms/*")', 'sec("bgp/shared-writer/*")', "sec(`bgp/project/${slug}/*`)"]) {
      expect(w, `写语句缺 ${face}`).toContain(face);
    }
    for (const a of ["secretsmanager:CreateSecret", "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret"]) {
      expect(w).toContain(`"${a}"`);
    }
  });

  it("读语句 OwnRegionSecretsRead 仍只认平台实名密钥(不许为 RDS 主密钥放宽成 secret:*)", () => {
    const r = stmt("OwnRegionSecretsRead");
    expect(r).toContain('sec("bgp/datasource/*")');
    expect(r).not.toMatch(/secret:\*|sec\("\*"\)|sec\(""\)/);
    expect(r).not.toContain("rds!db");
  });

  it("区域动作清单含 secretsmanager:ListSecrets(RDS 发现),且它只在区域条件语句里、不在无条件语句里", () => {
    const at = src.indexOf("REGIONAL_DATA_PLANE_ACTIONS: readonly string[] = [");
    expect(at).toBeGreaterThan(0);
    const arr = src.slice(at, src.indexOf("];", at));
    expect(arr).toContain('"secretsmanager:ListSecrets"');
    expect(stmt("OwnRegionSecretsRead")).not.toContain("ListSecrets");
    expect(stmt("OwnRegionCredentialSecretsWrite")).not.toContain("ListSecrets");
  });
});
