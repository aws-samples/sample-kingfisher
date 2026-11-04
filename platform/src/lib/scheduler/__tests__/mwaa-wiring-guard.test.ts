// @kf-batch 50-WP13-mwaa-region
// 🔴 接线守卫(ACCEPTANCE E-216 后半):「哪个 target 用哪套 Airflow」只许一个作者,调度入口在**任何写之前**核 MWAA。
// 为什么必须是静态守卫:这类 bug 的形状是「不报错、只是把该区的 DAG 又发到了 home」—— 单测跑不到那条路由就永远绿。
// 变异 M-1 去掉 publishFanout 的 requireMwaaForTargets ⇒ 红;M-2 offlineDag 调用方不带 targetId ⇒ 红;
// M-3 EMR DAG 的 ddb 用 EXEC_REGION ⇒ 红;M-4 任一路由回退 process.env.MWAA_ENV_NAME ⇒ 红。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
    const fp = resolve(dir, e);
    if (statSync(fp).isDirectory()) walk(fp, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(fp);
  }
  return acc;
};
function before(hay: string, needle: string, after: string, why: string) {
  const i = hay.indexOf(needle);
  const j = hay.indexOf(after);
  expect(i, `${why}:缺 ${needle}`).toBeGreaterThan(-1);
  expect(j, `${why}:缺 ${after}`).toBeGreaterThan(-1);
  expect(i, `${why}:${needle} 必须在 ${after} 之前`).toBeLessThan(j);
}

describe("🔴 单一作者:MWAA env 字面只在 mwaa-endpoint.ts", () => {
  it("MWAA_ENV_NAME / MWAA_DAG_BUCKET 在 platform/src 活代码里只出现在 lib/scheduler/mwaa-endpoint.ts", () => {
    const hits = walk(SRC)
      .filter((fp) => /MWAA_ENV_NAME|MWAA_DAG_BUCKET/.test(strip(readFileSync(fp, "utf8"))))
      .map((fp) => fp.slice(SRC.length + 1))
      .sort();
    expect(hits).toEqual(["lib/scheduler/mwaa-endpoint.ts"]);
  });
  it("裸 `bgp-mwaa` 环境名字面只在 mwaa-endpoint.ts(其余处从 endpoint 取)", () => {
    const hits = walk(SRC)
      .filter((fp) => /"bgp-mwaa"/.test(strip(readFileSync(fp, "utf8"))))
      .map((fp) => fp.slice(SRC.length + 1))
      .sort();
    expect(hits).toEqual(["lib/scheduler/mwaa-endpoint.ts"]);
  });
});

describe("🔴 调度入口:任何写之前先核 MWAA(缺 ⇒ 零产物,409 直达补装)", () => {
  it("ETL 扇出:publishFanout 先 requireMwaaForTargets 再 PutObject;桶 / 客户端都取 endpoint", () => {
    const src = strip(read("lib/etl/dag-fanout.ts"));
    before(src, "await requireMwaaForTargets(targets)", "new PutObjectCommand({", "缺 MWAA 必须零产物");
    expect(src).toContain("Bucket: ep.dagBucket");
    expect(src).toContain("await s3ClientFor(ep.region)");
    expect(src).not.toContain("new S3Client(");
    expect(src).toContain("await offlineDag(dagId, targetId)");
    expect(src).toContain('code: MWAA_NOT_INSTALLED_CODE');
  });
  it("ETL 路由:requireMwaaForTargets 在 ensureGlueJob 之前;MwaaNotInstalled ⇒ mwaaErrorResponse;解挂逐 target 经 endpoint", () => {
    const src = strip(read("app/api/etl-jobs/[id]/schedule/route.ts"));
    before(src, "await requireMwaaForTargets(wantedTargets)", "await ensureGlueJob(job, t)", "建 Glue 作业已是副作用");
    expect(src).toContain("if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e)");
    expect(src).toContain("unpauseWhenLoaded(ep, dagIds)");
    expect(src).not.toContain("CreateCliTokenCommand");
  });
  it("EMR 扇出:publishEmrFanout 先 requireMwaaForTargets 再 uploadScript / ensureApplication / PutObject;DAG 带 execRegion + ctrlRegion + targetId", () => {
    const src = strip(read("lib/engines/emr/schedule-fanout.ts"));
    before(src, "await requireMwaaForTargets(targets)", "await uploadScript(", "上传脚本已是副作用");
    before(src, "await requireMwaaForTargets(targets)", "await ensureApplication(", "建 application 已是副作用");
    before(src, "await requireMwaaForTargets(targets)", "new PutObjectCommand({", "缺 MWAA 必须零产物");
    expect(src).toContain("execRegion: landing.region");
    expect(src).toContain("ctrlRegion: homeRegion()"); // WP-31 L4:主控区只经唯一作者 lib/place/home-region 读
    expect(src).toContain("executionRoleArn: execRoleArn");
    expect(src).toContain("await offlineDag(dagId, targetId)");
  });
  it("EMR 路由:走 publishEmrFanout / offlineEmrFanout,不再自己拼 home 桶 / home 角色", () => {
    const src = strip(read("app/api/engines/[engine]/[id]/schedule/route.ts"));
    expect(src).toContain("await publishEmrFanout(");
    expect(src).toContain("await offlineEmrFanout(job)");
    expect(src).toContain("if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e)");
    expect(src).not.toContain("HOME_TARGET_ID");
    expect(src).not.toContain("PutObjectCommand");
  });
  it("EMR DAG 生成器:ddb 走 CTRL_REGION、emr 走 EXEC_REGION(控制面单份)", () => {
    const src = strip(read("lib/engines/emr/dag-generator.ts"));
    expect(src).toContain('emr = boto3.client("emr-serverless", region_name=EXEC_REGION)');
    expect(src).toContain('ddb = boto3.resource("dynamodb", region_name=CTRL_REGION)');
    expect(src).toContain("resolveRunStamp(job, ctx.targetId)");
  });
  it("下线助手:offlineDag(dagId, targetId) 经 endpoint 删该区桶、pause 该区环境;缺 MWAA 如实 skipped 不去 home 乱删", () => {
    const src = strip(read("lib/scheduler/mwaa-offline.ts"));
    // @kf-batch 50-WP17-serverless-workflow —— 🔴 **默认值已删**(WP-13 那个 `= HOME_TARGET_ID` 正是
    //   「漏传落点不报错、只是删错区的 DAG」的入口;真环境在 unpublish 路由上坐实)。落点现在必填,
    //   漏传是 tsc 错。本条判据跟着改成钉「必填」,并由 region-seam 门禁再钉一次「默认值不许回来」。
    expect(src).toContain("export async function offlineDag(dagId: string, targetId: string)");
    expect(src).toContain("await mwaaEndpointFor(targetId)");
    expect(src).toContain("Bucket: ep.dagBucket");
    expect(src).toContain("skipped:");
  });
});

describe("🔴 前端:调度区接了缺 MWAA 警示卡(不是 toast)+ 直达补装", () => {
  it("离线计算页 / EMR 面板都渲染 MwaaMissingNotice,发布失败走 extractMwaaMissing", () => {
    for (const rel of ["app/etl-jobs/page.tsx", "components/engines/EmrJobPanel.tsx"]) {
      const src = strip(read(rel));
      expect(src, rel).toContain("<MwaaMissingNotice payload={mwaaMissing}");
      expect(src, rel).toContain("extractMwaaMissing(d)");
    }
    const notice = strip(read("components/scheduler/MwaaMissingNotice.tsx"));
    expect(notice).toContain('data-testid="mwaa-missing-notice"');
    expect(notice).toContain('data-testid="mwaa-missing-fix"');
    expect(notice).toContain("router.push(payload.fix.href)");
  });
  it("执行环境页读深链 target/highlight 自动开抽屉;详情页组件行与〔补齐缺失组件〕有 testid、高亮行有提示", () => {
    const page = strip(read("app/exec-envs/page.tsx"));
    expect(page).toContain('q.get("target")');
    expect(page).toContain('q.get("highlight")');
    expect(page).toContain("highlightComponent={deepLink?.highlight");
    const detail = strip(read("app/exec-envs/TargetDetail.tsx"));
    expect(detail).toContain("data-testid={`component-row-${c.key}`}");
    // @kf-batch 50-PROD-B-seq33 ②:逐个「+ 补充部署」已取消 ⇒ 补装直达落到唯一的〔补齐缺失组件〕
    expect(detail).toContain('data-testid="fill-missing-components"');
    expect(detail).toContain('data-testid="component-highlight-alert"');
    const wizard = strip(read("app/exec-envs/CreateWizard.tsx"));
    expect(wizard).toContain("data-testid={`wizard-component-${c.key}`}");
  });
});
