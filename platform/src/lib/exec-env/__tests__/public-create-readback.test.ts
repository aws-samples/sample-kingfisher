// @kf-batch 42-B80-revoke-readback —— 撤 PUBLIC CREATE 的收口回读(台账 B-80)。
// 钉三件事:① nspacl / has_schema_privilege 的解析钉真环境原话;② 回读循环「读到 false 才算、预算用尽如实 unsettled、语句失败不算撤」;
// ③ 路由调用点:executeAdminDdl 之后必须回读,unsettled ⇒ 502,没凭证 ⇒ 200 带 verified:false。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script: Array<{ state: "finished"; scalar: string } | { state: "failed"; error: string }> = [];
const submitted: Array<{ sql: string; secretArn: string; region: string; statementName?: string }> = [];
vi.mock("@/lib/dataplane-jobs/statement", () => ({
  submitStatements: vi.fn(async (a: { place: { region: string }; sqls: string[]; secretArn: string; statementName?: string }) => {
    submitted.push({ sql: a.sqls[0], secretArn: a.secretArn, region: a.place.region, statementName: a.statementName });
    return `st${submitted.length}`;
  }),
  describeStatementState: vi.fn(async (_r: string, id: string) => {
    const step = script[Number(id.slice(2)) - 1] ?? script[script.length - 1];
    return step.state === "failed" ? { state: "failed", error: step.error } : { state: "finished", affected: 0, hasResultSet: true };
  }),
  firstScalar: vi.fn(async (_r: string, id: string) => {
    const step = script[Number(id.slice(2)) - 1] ?? script[script.length - 1];
    if (step.state !== "finished") throw new Error("no result");
    return step.scalar;
  }),
}));
// 同目录兄弟模块(项目清单 / 项目 secret / 落点)**不 vi.mock**(mock 卫生棘轮):走依赖注入传假协作方,默认依赖的身份另有判据钉住
let secrets: Record<string, string | undefined> = {};
let projects: string[] = [];
const deps = {
  listProjectsWithBindings: async () => projects,
  lookupProjectSecretArn: async (_t: unknown, pid: string) => secrets[pid],
  resolveTargetWarehouse: (t: { targetId: string; region?: string }) => ({ targetId: t.targetId, region: t.region ?? "us-west-2", workgroup: "wg", database: "dev" }),
} as any;

import {
  DEFAULT_READBACK_DEPS, PUBLIC_CREATE_READBACK_SQL, awaitPublicCreateRevoked, parsePublicCreateReadback, publicEntryHasCreate, readbackPublicCreateRevokedAsProject,
} from "../public-create-readback";
import { listProjectsWithBindings as realList } from "../project-cred-supply";
import { lookupProjectSecretArn as realLookup } from "../project-secret";
import { resolveTargetWarehouse as realWarehouse } from "../target-clients";

// 真环境原话(…4400 tgt_usw2_a 2026-10-15):撤前 / 撤后两种 nspacl
const BEFORE = "{rdsdb=UCDA/rdsdb,=UC/rdsdb,shared_writer=U/rdsdb}";
const AFTER = "{rdsdb=UCDA/rdsdb,=U/rdsdb,shared_writer=U/rdsdb}";

let clock = 0;
const now = () => clock;
const sleep = async (ms: number) => { clock += ms; };

beforeEach(() => { script.length = 0; submitted.length = 0; secrets = {}; projects = []; clock = 0; });

describe("① 解析", () => {
  it("PUBLIC 条目(以 = 开头)含 C 才算仍有 CREATE;别的 grantee 含 C 不算;无 PUBLIC 段 / 空 ACL / 带引号 grantee 都不算", () => {
    expect(publicEntryHasCreate(BEFORE)).toBe(true);
    expect(publicEntryHasCreate(AFTER)).toBe(false);
    expect(publicEntryHasCreate("{rdsdb=UCDA/rdsdb}")).toBe(false);
    expect(publicEntryHasCreate("")).toBe(false);
    expect(publicEntryHasCreate('{"a b"=UC/rdsdb,=U/rdsdb}')).toBe(false);
    expect(publicEntryHasCreate("{=C/rdsdb}")).toBe(true);
  });
  it("标量 `<nspacl>|<bool>`:目录与有效判定都为否才 revoked;有效判定仍 true(B-80 的窗口)⇒ 不算撤;形态不对就抛", () => {
    expect(parsePublicCreateReadback(`${AFTER}|false`)).toEqual({ nspacl: AFTER, publicHasCreate: false, effectiveHasCreate: false, revoked: true });
    expect(parsePublicCreateReadback(`${AFTER}|true`).revoked).toBe(false);
    expect(parsePublicCreateReadback(`${BEFORE}|false`).revoked).toBe(false);
    expect(parsePublicCreateReadback("|false").revoked).toBe(true); // nspacl NULL ⇒ COALESCE 成空
    expect(() => parsePublicCreateReadback("garbage")).toThrow(/缺 \|/);
    expect(() => parsePublicCreateReadback(`${AFTER}|maybe`)).toThrow(/不是布尔/);
  });
  it("回读语句只 SELECT 目录,不建任何对象;nspacl 用 COALESCE 兜 NULL", () => {
    expect(PUBLIC_CREATE_READBACK_SQL).toMatch(/^SELECT COALESCE\(nspacl::text, ''\) \|\| '\|' \|\| has_schema_privilege\('public', 'create'\)::text FROM pg_namespace WHERE nspname = 'public'$/);
    expect(PUBLIC_CREATE_READBACK_SQL).not.toMatch(/create table|drop|grant|revoke/i);
  });
});

describe("② 回读循环", () => {
  const place = { region: "us-west-2", workgroup: "wg", database: "dev" };
  it("前两次有效判定仍 true、第三次 false ⇒ settled,attempts=3,等待时间累计;每次都用项目 secret 发同一条语句", async () => {
    script.push({ state: "finished", scalar: `${AFTER}|true` }, { state: "finished", scalar: `${AFTER}|true` }, { state: "finished", scalar: `${AFTER}|false` });
    const r = await awaitPublicCreateRevoked({ place, secretArn: "arn:aws:secretsmanager:us-west-2:1:secret:p", statementName: "rb", budgetMs: 20_000, pollMs: 1_000, now, sleep });
    expect(r.settled).toBe(true);
    expect(r.attempts).toBe(3);
    expect(r.waitedMs).toBe(2_000);
    expect(submitted.every((s) => s.sql === PUBLIC_CREATE_READBACK_SQL && s.secretArn.endsWith(":p") && s.region === "us-west-2" && s.statementName === "rb")).toBe(true);
  });
  it("一直 true 到预算用尽 ⇒ settled:false 且带最后一次读到的样子(不许把超时当成已撤)", async () => {
    script.push({ state: "finished", scalar: `${BEFORE}|true` });
    const r = await awaitPublicCreateRevoked({ place, secretArn: "arn:x", budgetMs: 5_000, pollMs: 1_000, now, sleep });
    expect(r.settled).toBe(false);
    expect(r.attempts).toBe(6);
    expect(r.last).toEqual(expect.objectContaining({ publicHasCreate: true, effectiveHasCreate: true, revoked: false }));
  });
  it("语句失败 ⇒ 记错误继续试,预算用尽带 error;中途成功 ⇒ settled", async () => {
    script.push({ state: "failed", error: "ERROR: boom" }, { state: "finished", scalar: `${AFTER}|false` });
    const r = await awaitPublicCreateRevoked({ place, secretArn: "arn:x", budgetMs: 5_000, pollMs: 1_000, now, sleep });
    expect(r.settled).toBe(true);
    expect(r.attempts).toBe(2);
    script.length = 0; submitted.length = 0; clock = 0;
    script.push({ state: "failed", error: "ERROR: permission denied for relation pg_namespace" });
    const r2 = await awaitPublicCreateRevoked({ place, secretArn: "arn:x", budgetMs: 2_000, pollMs: 1_000, now, sleep });
    expect(r2.settled).toBe(false);
    expect(r2.error).toMatch(/permission denied/);
    expect(r2.last).toBeUndefined();
  });
});

describe("③ 以项目身份回读 + 路由接线", () => {
  const target = { targetId: "tgt_usw2_a", region: "us-west-2" } as any;
  it("第一个带凭证的项目做回读;settled ⇒ verified:true 带 projectId;返回值不含 ARN", async () => {
    projects = ["proj-a", "proj-b"]; secrets = { "proj-a": undefined, "proj-b": "arn:aws:secretsmanager:us-west-2:1:secret:b" };
    script.push({ state: "finished", scalar: `${AFTER}|false` });
    const r = await readbackPublicCreateRevokedAsProject(target, { budgetMs: 5_000, pollMs: 100 }, deps);
    expect(r).toEqual({ verified: true, projectId: "proj-b", outcome: expect.objectContaining({ settled: true, attempts: 1 }) });
    expect(JSON.stringify(r)).not.toContain("arn:");
    expect(submitted[0].secretArn).toContain(":b");
  });
  it("没有在用项目 / 都没凭证 ⇒ verified:false 且 unsettled:false(回读做不了,不冒充已验证)", async () => {
    expect(await readbackPublicCreateRevokedAsProject(target, undefined, deps)).toEqual({ verified: false, unsettled: false, reason: expect.stringContaining("没有在用项目") });
    projects = ["proj-a"];
    expect(await readbackPublicCreateRevokedAsProject(target, undefined, deps)).toEqual({ verified: false, unsettled: false, reason: expect.stringContaining("还没有 per-project 凭证") });
    expect(submitted.length).toBe(0);
  });
  it("默认依赖就是真函数(接缝接上了:项目清单 / 项目 secret / 落点都来自各自的单一作者)", () => {
    expect(DEFAULT_READBACK_DEPS.listProjectsWithBindings).toBe(realList);
    expect(DEFAULT_READBACK_DEPS.lookupProjectSecretArn).toBe(realLookup);
    expect(DEFAULT_READBACK_DEPS.resolveTargetWarehouse).toBe(realWarehouse);
  });
  it("路由:executeAdminDdl(revoke-public-create) 之后调用 readbackPublicCreateRevokedAsProject;unsettled ⇒ 502 UPSTREAM_ERROR;200 带 readback", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/api/admin/exec-envs/[targetId]/canary/route.ts"), "utf8");
    const exec = src.indexOf('executeAdminDdl(actor, { operation: "revoke-public-create"');
    const rb = src.indexOf("await readbackPublicCreateRevokedAsProject(t, ");
    expect(exec).toBeGreaterThan(0);
    expect(rb).toBeGreaterThan(exec);
    expect(src).toMatch(/if \(!readback\.verified && readback\.unsettled\) \{[\s\S]*?502,\s*\{ code: "UPSTREAM_ERROR" \}/);
    expect(src).toMatch(/apiOk\(\{ targetId: params\.targetId, action: "revoke-public-create", auditId: r\.auditId, readback \}\)/);
  });
});
