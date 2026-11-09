// (客户 2026-10-16 待改进项:数据湖配置入口没有表桶下拉)—— 接线判据。
// 「写了」≠「接上了」:下拉组件必须出现在两个调用点(同步任务 Table Bucket / 系统设置登记外部表桶),旧的手填 Input 不许回来;
// 组件只认一个清单接口;接口只认一个 lib 作者;lib 的 AWS 调用在 IAM 清单里登记。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..", "..");
const REPO = resolve(SRC, "..", "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");

describe("同步任务「S3 Tables 数据湖配置 → Table Bucket」", () => {
  const src = strip(read("app/sync/SyncTaskModal.tsx"));
  it("Form.Item s3Config.tableBucket 里是 TableBucketPicker,落点 = 源所在章(watchDsOwnerTarget);仍不设 initialValue,占位仍是「留空自动解析」", () => {
    expect(src).toMatch(/name=\{\["s3Config", "tableBucket"\]\}[\s\S]{0,400}<TableBucketPicker targetId=\{watchDsOwnerTarget\}[^\n]*placeholder=\{t\("留空自动解析"\)\}/);
    expect(src).not.toMatch(/<Input style=\{\{ width: 250 \}\} placeholder=\{t\("留空自动解析"\)\} \/>/);
    expect(src).not.toMatch(/name=\{\["s3Config", "tableBucket"\]\}[^\n]*initialValue/);
    expect(src).toContain('import TableBucketPicker from "@/components/lake/TableBucketPicker"');
  });
});

describe("系统设置「数据湖表桶与路由 → 登记」", () => {
  it("系统设置页把卡片交给 LakeRoutesCard(落点 = 当前执行范围);卡里登记输入是 TableBucketPicker(去掉平台表桶与已登记的;登记 / 撤销后重拉),testid lake-route-bucket;旧 Input 不许回来", () => {
    const settings = strip(read("app/settings/page.tsx"));
    expect(settings).toMatch(/<LakeRoutesCard targetId=\{lakeTargetId\}/);
    expect(settings).not.toMatch(/<TableBucketPicker/);
    const card = strip(read("components/lake/LakeRoutesCard.tsx"));
    expect(card).toMatch(/<TableBucketPicker targetId=\{targetId\} value=\{bucket\} onChange=\{\(v\) => \{ setBucket\(v \|\| ""\); \}\} excludePlatform excludeRegistered reloadToken=\{state\.routes\.length\}/);
    expect(card).toMatch(/data-testid="lake-route-bucket"/);
    expect(card).not.toMatch(/<Input placeholder=\{t\("表桶名/);
  });
});

describe("组件 → 接口 → lib → IAM 清单,一条线", () => {
  it("TableBucketPicker 只拉只读路径 /api/lake-buckets/candidates?targetId=(不在 /api/admin 之下),targetId 空不拉;AutoComplete(可手填)而不是 Select", () => {
    const src = strip(read("components/lake/TableBucketPicker.tsx"));
    expect(src).toMatch(/fetch\(`\/api\/lake-buckets\/candidates\?targetId=\$\{encodeURIComponent\(targetId\)\}`\)/);
    expect(src).toMatch(/if \(!targetId\) \{ setState\(\{ status: "idle" \}\); return; \}/);
    expect(src).toContain("<AutoComplete");
    expect(src).not.toMatch(/<Select[\s>]/);
    expect(src).toContain('data-bucket-list-status={state.status}');
  });
  it("路由:登录即可读、requestedTargetId 点名、listTableBucketCandidates 唯一作者、失败 502 UPSTREAM_ERROR", () => {
    const src = strip(read("app/api/lake-buckets/candidates/route.ts"));
    expect(src).toContain('import { listTableBucketCandidates } from "@/lib/lake/table-bucket-candidates"');
    expect(src).toMatch(/requestedTargetId\(req\.nextUrl\.searchParams\.get\("targetId"\)/);
    expect(src).toMatch(/apiOk\(await listTableBucketCandidates\(tid\)\)/);
    expect(src).toMatch(/502, \{ code: "UPSTREAM_ERROR" \}/);
  });
  it("lib 的落点 / 路由表都走既有唯一作者(resolveS3TablesPlace / resolveLakeRoutes),AWS 调用只有 ListTableBuckets 且登记在 IAM 清单", () => {
    const src = strip(read("lib/lake/table-bucket-candidates.ts"));
    expect(src).toContain('await import("@/lib/athena/s3tables")');
    // 数据湖表桶路由:路由表(别名 / 分层 / 可写)来自唯一作者 lib/lake/routes(fresh 读);外部表桶薄壳不再是读点
    expect(src).toContain('await import("@/lib/lake/routes")');
    expect(src).not.toContain("external-table-buckets");
    expect((src.match(/new [A-Z][A-Za-z]+Command\(/g) || []).sort()).toEqual(["new ListTableBucketsCommand("]);
    const manifest = JSON.parse(readFileSync(resolve(REPO, "infra/iam/platform-taskrole-calls.json"), "utf8")) as { calls: { action: string; source: string }[] };
    const mine = manifest.calls.filter((c) => c.source === "platform/src/lib/lake/table-bucket-candidates.ts").map((c) => c.action);
    expect(mine).toEqual(["s3tables:ListTableBuckets"]);
  });
});
