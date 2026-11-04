/**
 * 钉住实时计算的**执行下推**。用户 2026-09-10:
 * 「一定要加这个维度,不然白干了,所有任务都在自己的区域跑,不然没有意义。」
 *
 * 这一组判据全是**负向 + 结构性**的:区域下推的错法不会报错,只会「跑在了别的区」——
 * 没有一个断言能靠「跑一遍看没报错」得到,只能钉住那些让它出错的写法本身。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flinkJobTarget, resolveSql, outputPath, sourceStreamArn } from "../flink-service";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
/** 🔴 负向文本断言必须先剥注释:本仓的合同注释里逐字写着「原来是 new XxxClient(...)」。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";

describe("flinkJobTarget:作业行 → 落点", () => {
  it("有章用章;多区取第一个", () => {
    expect(flinkJobTarget({ targets: [USW2] })).toBe(USW2);
    expect(flinkJobTarget({ targets: [USW2, HOME] })).toBe(USW2);
  });
  it("🔴 无章的存量作业回落主控区(落章之前流作业只能在主控区跑,这是历史事实)", () => {
    expect(flinkJobTarget({})).toBe(HOME);
    expect(flinkJobTarget(null)).toBe(HOME);
    expect(flinkJobTarget({ targets: [] })).toBe(HOME);
  });
});

describe("落点事实进 SQL 与产物路径", () => {
  it("🔴 `${REGION}` / `${OUTPUT_PATH}` 必须按落点解析,而不是主控区", () => {
    const sql = "WITH ('aws.region'='${REGION}', 'path'='${OUTPUT_PATH}')";
    const at = resolveSql(sql, "job1", {
      targetId: USW2, region: "us-west-2", account: "1", roleArn: "r",
      codeBucket: "cb", outputBucket: "ob-usw2", s3tablesBucket: "tb",
      subnetIds: [], securityGroupIds: [], home: false,
    });
    expect(at).toContain("us-west-2");
    expect(at).toContain("s3://ob-usw2/flink-out/job1/");
    // 落点必填:不再有「不传 ⇒ 主控区常量」这条路(类型层面就写不出来)
  });
  it("产物桶与源流 ARN 都能按区给出", () => {
    expect(outputPath("j", "b2")).toBe("s3://b2/flink-out/j/");
    expect(sourceStreamArn("eu-west-1")).toContain(":eu-west-1:");
  });
});

describe("🔴 结构性:模块级主控区客户端不许复活", () => {
  const svc = strip(read("lib/realtime/flink-service.ts"));
  const conn = strip(read("lib/realtime/flink-connectors.ts"));

  it("flink-service 里不许再有任何模块级 AWS 客户端", () => {
    for (const bad of [
      "new KinesisAnalyticsV2Client(",
      "new S3Client(",
      "new CloudWatchLogsClient(",
      "new CloudWatchClient(",
      "new SecretsManagerClient(",
      "new RDSClient(",
    ]) {
      expect(svc, `${bad} 复活 ⇒ 非主控区的作业会被当成「不存在」或直接写回主控区`).not.toContain(bad);
    }
    // 客户端必须从落点来
    expect(svc).toContain("flinkClients(");
    expect(svc).toContain("resolveFlinkPlace(");
  });

  it("flink-connectors 的装配结果必须写进**作业所在区**的桶", () => {
    // 只允许一个 home 客户端(连接器规范副本在主控区),写侧必须走 place
    expect(conn).toContain("s3For(place)");
    expect(conn, "缓存命中判断也必须在目标区做,否则「命中」了但那个区没有这个 key").toContain("s3Exists(cacheKey, place)");
    expect(conn).not.toMatch(/PutObjectCommand\(\{ Bucket: FLINK\.codeBucket, Key: (key|cacheKey)/);
  });

  it("启动路由必须有**反向卡**:章说别区而那个区的通道解析不出来 ⇒ 拒跑,不静默落主控区", () => {
    const start = strip(read("app/api/flink/jobs/[id]/start/route.ts"));
    expect(start).toContain("flinkJobTarget(job)");
    expect(start).toContain("TARGET_PUSHDOWN_UNAVAILABLE");
    expect(start, "启动前要真解析一遍落点").toContain("resolveFlinkPlace(");
  });

  it("新建作业要盖章,并且**当场真解析一遍**(不许先存下来等启动才炸)", () => {
    const route = strip(read("app/api/flink/jobs/route.ts"));
    // 一次提交可以给**多个区**(流式作业天生一区一个应用 ⇒
    //   语义是「每区各建一个作业」)。判据钉事实:逐区盖章 + 逐区真解析 + 落点不裸抄。
    expect(route, "每个作业各盖自己那一个区的章").toContain("targets: [t]");
    // 新建与启动同一个作者(主控区也不跳过)
    expect(route).toContain("resolveFlinkPlace(t)");
    expect(route, "主控区不许跳过真解析").not.toMatch(/if \(t === HOME_TARGET_ID\) continue/);
    expect(route, "落点不许从 ...body 裸抄").toContain("isValidTargetId");
    expect(route, "列表要按范围过滤").toContain("filterRowsByScope(");
    // 🔴 反例:回到「只认一个 targetId、写死单值」就红
    expect(route).not.toContain("targets: [wantTarget]");
  });

  it("页面新建给的是**多选**执行区 + 全选按钮 + 说清语义(每区各建一个作业,不是一个作业跑两区)", () => {
    const page = strip(read("app/realtime-compute/page.tsx"));
    expect(page).toContain('data-testid="flink-create-targets"');
    expect(page).toContain('data-testid="flink-create-targets-all"');
    expect(page).toContain('mode="multiple"');
    expect(page, "语义要在界面上说清:一区一个应用").toContain("个区各建一个作业");
    expect(page, "多区时提交 targets 多值").toMatch(/\{ targets: newJobTargets \}/);
  });

  it("🔴🔴 实时作业不许跨区取数:源/目标数据源的落点章必须与作业要建的区一致", () => {
    const route = strip(read("app/api/flink/jobs/route.ts"));
    expect(route).toContain("ownerTargetId");
    expect(route).toContain("不许跨区取数");
    // 拒的时候要说清**哪个源属于哪个区**(否则用户不知道该去建什么)
    expect(route).toMatch(/属于 \$\{owner\}/);
  });

  it("runner JAR 必须先确保在该区的代码桶里(缺 JAR 时 MSAF 只报「取不到 fileKey」)", () => {
    expect(svc).toContain("ensureRunnerJar(ctx, codeKey)");
  });

  it("🔴 启动时的落点必须来自**作业自己的章**(变异验证补的判据)", () => {
    // 变异验证时把 `ctxFor(opts?.targetId)` 改成 `ctxFor(undefined)`(= 一律主控区),
    // 上面 8 条判据**全绿** —— 最关键的那一行当时没有任何判据看着它。这就是那条判据。
    expect(svc, "startFlinkJob 必须用 opts.targetId 建落点,否则所有作业都跑回主控区").toContain(
      "const ctx = await ctxFor(opts.targetId);"
    );
    expect(svc).not.toContain("ctxFor(undefined)");
    const start = strip(read("app/api/flink/jobs/[id]/start/route.ts"));
    expect(start, "路由必须把作业行上的章传进去").toContain("targetId: jobTarget");
    // 装配落点也必须是该作业的区(写回主控区 ⇒ MSAF 在本区找不到那个 key)
    expect(svc).toContain("{ region: ctx.region, codeBucket: ctx.codeBucket }");
  });
});

// 收尾:Flink 主控区分支改走描述符的**防回退**判据。
// 行为侧(主控区值全部来自描述符 / 缺组件缺桶 ⇒ 409 不回落)在 `flink-place-decision.test.ts`;本段钉写法:
// 一旦有人把「主控区 ⇒ FLINK 常量」或「不给落点 ⇒ 主控区」加回来,这里当场红。
describe("🔴🔴 Flink 落点:主控区不再有常量分支,落点参数不再可选", () => {
  const code = (p: string) => strip(read(p)).replace(/^import [\s\S]*?;$/gm, "");
  const place = code("lib/realtime/flink-place.ts");
  const svc2 = code("lib/realtime/flink-service.ts");
  const conn2 = code("lib/realtime/flink-connectors.ts");

  it("resolveFlinkPlace 只走描述符:没有 isHome 分支、不读 FLINK 的区域性常量", () => {
    expect(place).toMatch(/resolvePlace\(ref, \{ via: "resolveFlinkPlace", component: "flink" \}\)/);
    expect(place).not.toMatch(/\bisHome\(|\bHOME_TARGET_ID\b/);
    expect(place).not.toMatch(/FLINK\.(region|roleArn|outputBucket|s3tablesBucket|subnetIds|account)\b/);
    expect(place, "资源只许经 placeResource 取").toMatch(/placeResource\(place, "scriptsBucket"\)/);
    expect(place).toMatch(/placeResource\(place, "datalakeBucket"\)/);
    expect(place).toMatch(/placeResource\(place, "tableBucket"\)/);
    expect(place, "不按身份跳过 JAR 投递").not.toMatch(/if \(p\.home\)/);
  });

  it("flink-service / flink-connectors 里不许再有「不给落点 ⇒ 主控区常量」的参数缺省", () => {
    expect(svc2).not.toMatch(/place\?\s*:\s*FlinkPlace/);
    expect(svc2).not.toMatch(/=\s*FLINK\.(region|outputBucket|roleArn|codeBucket)\b/);
    expect(svc2).not.toMatch(/place\s*\?\s*place\.\w+\s*:\s*FLINK\./);
    expect(conn2).not.toMatch(/=\s*HOME_JAR_PLACE|HOME_JAR_PLACE\s*:/);
  });

  it("新建侧与启动侧同一个作者;旧的双口径作者 resolveFlinkBinding 不许复活", () => {
    expect(code("lib/exec-env/data-plane-target.ts")).not.toMatch(/export async function resolveFlinkBinding/);
    expect(code("lib/exec-env/target-clients.ts")).not.toMatch(/FLINK_RUNTIME_ROLE_ARN/);
  });
});
