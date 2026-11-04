// @kf-batch 43-page-sweep(B-91)—— S3 Tables 联邦目录 s3tablescatalog:运行时唯一作者的行为 + 安装脚本入参逐字段相同 + 接缝调用点。
// 「写了」≠「接上了」:同步启动 / 直查 / deploy-all / redeploy-platform / 真就位 / IAM 清单六处都要有**调用点**,不是只有 import。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3TABLES_FEDERATED_CATALOG_ID,
  ensureS3TablesFederatedCatalog,
  s3TablesFederatedCatalogInput,
  touchesS3TablesCatalog,
} from "../s3tables-catalog";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join("\n");

const EXPECTED_INPUT = {
  Description: "Federated catalog for S3 Tables",
  FederatedCatalog: { Identifier: "arn:aws:s3tables:us-west-2:1111222233ab:bucket/*", ConnectionName: "aws:s3tables" },
  CreateDatabaseDefaultPermissions: [{ Principal: { DataLakePrincipalIdentifier: "IAM_ALLOWED_PRINCIPALS" }, Permissions: ["ALL"] }],
  CreateTableDefaultPermissions: [{ Principal: { DataLakePrincipalIdentifier: "IAM_ALLOWED_PRINCIPALS" }, Permissions: ["ALL"] }],
};

function fakeGlue(plan: { get?: "ok" | Error; create?: "ok" | Error }) {
  const sent: { name: string; input: any }[] = [];
  const send = async (cmd: any) => {
    const name = cmd?.constructor?.name || "";
    sent.push({ name, input: cmd?.input });
    if (name === "GetCatalogCommand") {
      if (plan.get instanceof Error) throw plan.get;
      return { Catalog: { Name: S3TABLES_FEDERATED_CATALOG_ID } };
    }
    if (name === "CreateCatalogCommand") {
      if (plan.create instanceof Error) throw plan.create;
      return {};
    }
    throw new Error(`unexpected ${name}`);
  };
  return { glue: { send } as any, sent };
}
const notFound = Object.assign(new Error("Catalog s3tablescatalog not found"), { name: "EntityNotFoundException" });
const alreadyExists = Object.assign(new Error("Catalog already exists"), { name: "AlreadyExistsException" });
const denied = Object.assign(new Error("not authorized to perform: glue:CreateCatalog"), { name: "AccessDeniedException" });
const WHERE = { region: "us-west-2", accountId: "1111222233ab" };

describe("B-91 入参与判定", () => {
  it("开通入参逐字段(Identifier 按区 + 账号拼本区全部表桶;ConnectionName aws:s3tables;两组默认权限 IAM_ALLOWED_PRINCIPALS ALL)", () => {
    expect(s3TablesFederatedCatalogInput("us-west-2", "1111222233ab")).toStrictEqual(EXPECTED_INPUT);
  });
  it("touchesS3TablesCatalog:三段名 / 上下文目录命中;S3 外表库 / 普通 SQL 不命中(别的 Athena 查询不碰 Glue)", () => {
    expect(touchesS3TablesCatalog('SELECT * FROM "s3tablescatalog/bgp-table-bucket"."ods"."t" LIMIT 100')).toBe(true);
    expect(touchesS3TablesCatalog("SELECT 1", { catalog: "s3tablescatalog/bgp-table-bucket", database: "ods" })).toBe(true);
    expect(touchesS3TablesCatalog("SELECT * FROM bgp_s3_external.t", { database: "bgp_s3_external" })).toBe(false);
    expect(touchesS3TablesCatalog("CREATE DATABASE IF NOT EXISTS bgp_s3_external")).toBe(false);
  });
});

describe("B-91 ensureS3TablesFederatedCatalog(只 mock 真外部 Glue 客户端)", () => {
  it("目录已在 ⇒ 只 GetCatalog 一次,不建 ⇒ existed", async () => {
    const { glue, sent } = fakeGlue({ get: "ok" });
    await expect(ensureS3TablesFederatedCatalog(glue, WHERE)).resolves.toBe("existed");
    expect(sent.map((s) => s.name)).toEqual(["GetCatalogCommand"]);
    expect(sent[0].input).toStrictEqual({ CatalogId: "s3tablescatalog" });
  });
  it("目录不在 ⇒ GetCatalog 后 CreateCatalog,入参 = s3TablesFederatedCatalogInput ⇒ created", async () => {
    const { glue, sent } = fakeGlue({ get: notFound, create: "ok" });
    await expect(ensureS3TablesFederatedCatalog(glue, WHERE)).resolves.toBe("created");
    expect(sent.map((s) => s.name)).toEqual(["GetCatalogCommand", "CreateCatalogCommand"]);
    expect(sent[1].input).toStrictEqual({ Name: "s3tablescatalog", CatalogInput: EXPECTED_INPUT });
  });
  it("并发建成 AlreadyExists ⇒ 视为成功 existed(幂等)", async () => {
    const { glue } = fakeGlue({ get: notFound, create: alreadyExists });
    await expect(ensureS3TablesFederatedCatalog(glue, WHERE)).resolves.toBe("existed");
  });
  it("建不成(AccessDenied)⇒ 原错如实上抛,不吞", async () => {
    const { glue } = fakeGlue({ get: notFound, create: denied });
    await expect(ensureS3TablesFederatedCatalog(glue, WHERE)).rejects.toBe(denied);
  });
  it("缺 region ⇒ 抛且一个调用都不发(不猜主控区)", async () => {
    const { glue, sent } = fakeGlue({ get: "ok" });
    await expect(ensureS3TablesFederatedCatalog(glue, { region: "", accountId: "1111222233ab" })).rejects.toThrow(/region/);
    expect(sent).toHaveLength(0);
  });
  it("缺 accountId:目录已在 ⇒ 照常 existed(不拦本来能跑的查询);目录不在 ⇒ 抛清楚的话、不盲建", async () => {
    const ok = fakeGlue({ get: "ok" });
    await expect(ensureS3TablesFederatedCatalog(ok.glue, { region: "us-west-2", accountId: "" })).resolves.toBe("existed");
    expect(ok.sent.map((s) => s.name)).toEqual(["GetCatalogCommand"]);
    const missing = fakeGlue({ get: notFound, create: "ok" });
    await expect(ensureS3TablesFederatedCatalog(missing.glue, { region: "us-west-2", accountId: "" })).rejects.toThrow(/缺 accountId/);
    expect(missing.sent.map((s) => s.name)).toEqual(["GetCatalogCommand"]);
  });
});

describe("B-91 安装脚本与运行时入参逐字段相同(scripts/lib/s3tables-catalog.sh)", () => {
  const sh = read("scripts/lib/s3tables-catalog.sh");
  it("bash 的 --catalog-input JSON 代入 region / 账号后与 s3TablesFederatedCatalogInput 深等", () => {
    const m = sh.match(/input=\$\(printf '(\{.*\})' "\$region" "\$acct"\)/);
    expect(m, "lib 里要有 printf 格式的 --catalog-input").toBeTruthy();
    const json = m![1].replace("%s", "us-west-2").replace("%s", "1111222233ab");
    expect(JSON.parse(json)).toStrictEqual(EXPECTED_INPUT);
  });
  it("幂等:先 get-catalog 判存在;读不到(非 EntityNotFound)⇒ die 不盲建;建后回读核对", () => {
    const body = sh; // 🔴 不 strip:bash 的 case 分支 `*EntityNotFoundException*` 行首是 `*`,会被当注释剥掉
    expect(body).toMatch(/aws glue get-catalog --catalog-id "\$S3TABLES_CATALOG_ID"/);
    expect(body).toMatch(/\*EntityNotFoundException\*/);
    expect(body).toMatch(/s3tables_catalog_exists "\$region" \|\| rc=\$\?/); // set -e 之下不许 `f; rc=$?`
    expect(body).toMatch(/2\) die /);
    expect(body).toMatch(/aws glue create-catalog --profile "\$PROFILE" --region "\$region" --name "\$S3TABLES_CATALOG_ID" --catalog-input "\$input"/);
    expect(body).toMatch(/\[ "\$rc" = 0 \] \|\| die /);
  });
});

describe("B-91 接缝:七处调用点都在(不是只有 import)", () => {
  it("同步启动 lib/sync/start-run.ts 调 ensureS3TablesFederatedCatalog(glue, 落点区, 表桶 ARN 里的账号),且不再自己拼 CreateCatalogCommand", () => {
    const src = strip(read("platform/src/lib/sync/start-run.ts"));
    expect(src).toMatch(/await ensureS3TablesFederatedCatalog\(glue, \{ region: landing\.region, accountId \}\);/);
    expect(src).not.toMatch(/CreateCatalogCommand|GetCatalogCommand/);
  });
  it("直查 lib/athena/client.ts#startQuery:命中联邦目录的查询先 ensure(按落点区取 Glue 客户端),再 StartQueryExecution", () => {
    const src = strip(read("platform/src/lib/athena/client.ts"));
    const fn = src.match(/export async function startQuery\([\s\S]*?\n\}/);
    expect(fn, "startQuery 存在").toBeTruthy();
    const body = fn![0];
    const iEnsure = body.indexOf("if (touchesS3TablesCatalog(query, context)) {");
    const iCall = body.indexOf("await ensureS3TablesFederatedCatalog(await glueClientFor(r), { region: r, accountId: process.env.AWS_ACCOUNT_ID || \"\" });");
    const iStart = body.indexOf("new StartQueryExecutionCommand({");
    expect(iEnsure).toBeGreaterThan(-1);
    expect(iCall).toBeGreaterThan(iEnsure);
    expect(iStart).toBeGreaterThan(iCall);
  });
  it("deploy-all.sh:source lib + 第 6.3 步在子 shell 里 ensure 主控区(run_step 记账)", () => {
    const sh = strip(read("scripts/deploy-all.sh"));
    expect(sh).toMatch(/source "\$HERE\/lib\/s3tables-catalog\.sh"/);
    expect(sh).toMatch(/s3tables_catalog_step\(\) \{ \( ensure_s3tables_catalog "\$REGION" \); \}/);
    expect(sh).toMatch(/run_step "6\.3\) S3 Tables 联邦目录 s3tablescatalog\(主控区\)" s3tables_catalog_step/);
  });
  it("redeploy-platform.sh:source lib + 第 3c 步对主控区与每个**真有执行环境**的区 ensure(升级即补齐存量环境;序 48 起不含候选区)", () => {
    const sh = strip(read("scripts/redeploy-platform.sh"));
    expect(sh).toMatch(/source "\$HERE\/lib\/s3tables-catalog\.sh"/);
    // 序 48:3c 的清单是 actual(home ∪ 注册表在用区),不是含候选区的放行清单 —— 候选区里还没有东西,不为「将来可能用」建对象
    expect(sh).toMatch(/EXEC_REGIONS_ACTUAL=\$\(exec_regions_actual\)/);
    expect(sh).toMatch(/for r in \$\{EXEC_REGIONS_ACTUAL\/\/,\/ \}; do ensure_s3tables_catalog "\$r"; done/);
    expect(sh).not.toMatch(/for r in \$\{EXEC_REGIONS\/\/,\/ \}; do ensure_s3tables_catalog/);
  });
  // 序 48:候选区内在页面新建的执行区不再经 redeploy-platform 第 3c 步 ⇒ 「检测初始化」必须对该区幂等 ensure(作者仍是同一个函数)
  it("probe-runner.ts:core 探活含 lake:s3tablescatalog 一项,按目标区取 Glue 客户端调 ensureS3TablesFederatedCatalog(账号取描述符)", () => {
    const src = strip(read("platform/src/lib/exec-env/probe-runner.ts"));
    const iItem = src.indexOf('probeOne("lake:s3tablescatalog"');
    expect(iItem).toBeGreaterThan(-1);
    const body = src.slice(iItem, iItem + 900);
    expect(body).toMatch(/sdkClient\("data-plane", GlueClient, \{ region \}\)/);
    expect(body).toMatch(/await ensureS3TablesFederatedCatalog\(glue, \{ region, accountId: target\.accountId \|\| process\.env\.AWS_ACCOUNT_ID \|\| "" \}\)/);
    expect(src).not.toMatch(/CreateCatalogCommand|GetCatalogCommand/);
  });
  it("02-postdeploy-truth.sh 第 10 条:get-catalog s3tablescatalog 的 FederatedCatalog.ConnectionName 必须是 aws:s3tables", () => {
    const sh = strip(read("scripts/02-postdeploy-truth.sh"));
    expect(sh).toMatch(/aws glue get-catalog \$P --catalog-id s3tablescatalog --query 'Catalog\.FederatedCatalog\.ConnectionName'/);
    expect(sh).toMatch(/\[ "\$CAT" = "aws:s3tables" \] && ok /);
  });
  it("IAM 清单登记 glue:GetCatalog / glue:CreateCatalog / glue:PassConnection,source 指到唯一作者;platform-stack.ts 有三个动作字面", () => {
    const manifest = JSON.parse(read("infra/iam/platform-taskrole-calls.json")) as { calls: { action: string; source: string; resource: string }[] };
    const mine = manifest.calls.filter((c) => c.source === "platform/src/lib/aws/s3tables-catalog.ts");
    expect(mine.map((c) => c.action).sort()).toEqual(["glue:CreateCatalog", "glue:GetCatalog", "glue:PassConnection"]);
    expect(mine.find((c) => c.action === "glue:PassConnection")!.resource).toBe("arn:aws:glue:{region}:{acct}:connection/aws:s3tables");
    const stack = read("infra/lib/platform-stack.ts");
    for (const a of ["glue:GetCatalog", "glue:CreateCatalog", "glue:PassConnection"]) expect(stack, `platform-stack.ts 缺 ${a}`).toContain(`"${a}"`);
  });
});
