// @kf-batch 50-W5-seg1-WP10a
// Glue 作业名 per-target 单一作者(E-142 真环境洞的根治门禁):
//   ① home 名逐字节不变 ② 非 home 带 target slug、同 region 两个 target **不同名** ③ 非法 targetId 拒
//   ④ 接线守卫:job-service / dag-generator / schedule 路由都调 `glueJobNameFor`,仓内不再有第二处拼 `bgp-etl-${`
//   ⑤ EMR application 名同款 per-target
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { glueJobBaseName, glueJobNameFor, glueJobNamesOf, GLUE_JOB_NAME_MAX } from "@/lib/etl/glue-job-name";
import { applicationNameFor } from "@/lib/engines/emr/application";
import { generateEtlJobDag } from "@/lib/etl/dag-generator";
import type { EtlJob } from "@/types/etl-job";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const JOB = "01M1N39N0ED1JG80QGB044767E";

describe("glueJobNameFor:per-target 作业名", () => {
  it("home 名 = bgp-etl-<jobId 尾 12 位>(存量逐字节不变;缺省即 home)", () => {
    expect(JOB.slice(-12)).toBe("80QGB044767E");
    expect(glueJobBaseName(JOB)).toBe("bgp-etl-80QGB044767E");
    expect(glueJobNameFor(JOB)).toBe("bgp-etl-80QGB044767E");
    expect(glueJobNameFor(JOB, "tgt_home")).toBe(glueJobBaseName(JOB));
  });

  it("🔴 非 home 带 target slug;同 region 的两个 target 名字**不同**(E-142:同名会互相覆盖 Role)", () => {
    const a = glueJobNameFor(JOB, "tgt_usw2_a");
    const b = glueJobNameFor(JOB, "tgt_usw2_b");
    expect(a).toBe(`${glueJobBaseName(JOB)}-tgt-usw2-a`);
    expect(b).toBe(`${glueJobBaseName(JOB)}-tgt-usw2-b`);
    expect(a).not.toBe(b);
    expect(a).not.toBe(glueJobNameFor(JOB)); // 也不与 home 撞
    expect(a.length).toBeLessThanOrEqual(GLUE_JOB_NAME_MAX);
  });

  it("非法 targetId 拒(fail-closed:拼错名 = 在别处建垃圾作业)", () => {
    expect(() => glueJobNameFor(JOB, "usw2")).toThrow();
    expect(() => glueJobNameFor(JOB, "tgt_USW2")).toThrow();
    expect(() => glueJobNameFor("", "tgt_usw2_a")).toThrow(/jobId/);
  });

  it("glueJobNamesOf:每个绑定 target 一份、去重;绑定为空按 home", () => {
    expect(glueJobNamesOf(JOB, ["tgt_home", "tgt_usw2_a", "tgt_usw2_a", "tgt_usw2_b"]).map((x) => x.name)).toEqual([
      glueJobBaseName(JOB),
      `${glueJobBaseName(JOB)}-tgt-usw2-a`,
      `${glueJobBaseName(JOB)}-tgt-usw2-b`,
    ]);
    expect(glueJobNamesOf(JOB, [])).toEqual([{ targetId: "tgt_home", name: glueJobBaseName(JOB) }]);
  });
});

describe("定时 DAG 用的是**本份 DAG 的 target** 的作业名(不是作业行上那个跨区同名值)", () => {
  const base: EtlJob = {
    userId: "default-user",
    jobId: JOB,
    name: "t",
    type: "glue",
    script: "print(1)",
    projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    glueJobName: "bgp-etl-STALE-SHARED-NAME", // 故意塞一个旧的跨区同名值:生成器必须忽略它
  } as EtlJob;
  it("usw2_a 的 DAG 触发 …-tgt-usw2-a,usw2_b 的触发 …-tgt-usw2-b,home 的触发 home 名", () => {
    process.env.AWS_REGION = "us-east-1";
    const a = generateEtlJobDag({ ...base, targetId: "tgt_usw2_a" } as EtlJob, { execRegion: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", targetId: "tgt_usw2_a" });
    const b = generateEtlJobDag({ ...base, targetId: "tgt_usw2_b" } as EtlJob, { execRegion: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-b", database: "dev", targetId: "tgt_usw2_b" });
    const h = generateEtlJobDag({ ...base, targetId: "tgt_home" } as EtlJob, { targetId: "tgt_home" });
    expect(a).toContain(`job_name = "${glueJobBaseName(JOB)}-tgt-usw2-a"`);
    expect(b).toContain(`job_name = "${glueJobBaseName(JOB)}-tgt-usw2-b"`);
    expect(h).toContain(`job_name = "${glueJobBaseName(JOB)}"`);
    for (const py of [a, b, h]) expect(py).not.toContain("STALE-SHARED-NAME");
  });
});

describe("EMR application 名同款 per-target", () => {
  it("home 名不变;非 home 带 slug;≤ 64 字符", () => {
    expect(applicationNameFor(JOB)).toBe(`bgp-emr-${JOB.slice(-12)}`);
    expect(applicationNameFor(JOB, "tgt_home")).toBe(`bgp-emr-${JOB.slice(-12)}`);
    expect(applicationNameFor(JOB, "tgt_usw2_b")).toBe(`bgp-emr-${JOB.slice(-12)}-tgt-usw2-b`);
    expect(applicationNameFor(JOB, "tgt_usw2_b").length).toBeLessThanOrEqual(64);
    expect(() => applicationNameFor(JOB, "bogus")).toThrow();
  });
});

describe("接线守卫:作业名只有一个作者", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
      const fp = resolve(d, e);
      if (statSync(fp).isDirectory()) walk(fp);
      else if (/\.(ts|tsx)$/.test(e)) files.push(fp);
    }
  };
  walk(SRC);
  const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("🔴 仓内除 glue-job-name.ts 外没有第二处拼 `bgp-etl-${`(第二处就是下一个「跨区同名」)", () => {
    const hits = files
      .filter((fp) => !fp.endsWith("lib/etl/glue-job-name.ts"))
      .filter((fp) => strip(readFileSync(fp, "utf8")).includes("`bgp-etl-${"))
      .map((fp) => fp.slice(SRC.length + 1));
    expect(hits).toEqual([]);
  });

  it("job-service / dag-generator / schedule 路由都从单一作者取名;job-service 不再把 job.glueJobName 当权威", () => {
    const js = strip(readFileSync(resolve(SRC, "lib/etl/job-service.ts"), "utf8"));
    const dg = strip(readFileSync(resolve(SRC, "lib/etl/dag-generator.ts"), "utf8"));
    const sr = strip(readFileSync(resolve(SRC, "app/api/etl-jobs/[id]/schedule/route.ts"), "utf8"));
    for (const src of [js, dg, sr]) expect(src).toContain("glueJobNameFor(");
    expect(js).not.toMatch(/job\.glueJobName\s*\|\|/);
    expect(dg).not.toContain("job.glueJobName ||");
    // 删作业随删 Glue 定义(每 target 一份)
    expect(js).toContain("export async function deleteGlueJobs(");
    expect(strip(readFileSync(resolve(SRC, "app/api/etl-jobs/[id]/route.ts"), "utf8"))).toContain("deleteGlueJobs(");
  });
});
