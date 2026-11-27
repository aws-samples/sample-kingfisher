// 直接写 Scan 的地方 —— **棘轮**(只减不增)+ 已改的列表读取必须经「读到完为止」的唯一作者。
//
// 缺陷原形(2026-11-27):一批「列出全部」的读取只读了第一页。存储服务一次最多读 1MB,表里的内容加起来超过它之后,
//   后面的行被无声丢掉:列表里看不到新建的对象;「发布到环境」找不到目标环境那一份就再建一份。
// 认法:产品源里(`src/app/api`、`src/lib`,不含判据)每个文件直接 `new ScanCommand(` 的处数。
//   要「全部」的读取一律用 `scanAll`(lib/aws/read-all.ts);留下直接写的每个文件登记在下面并写明为什么可以:
//   有意只取有限条(带 Limit),或者自己在跟下一页。新文件再直接写一处 Scan ⇒ 这里红。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(SRC, p).split("\\").join("/");
const FILES = [...sourceFiles(resolve(SRC, "app/api")), ...sourceFiles(resolve(SRC, "lib"))];
const countOf = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** 2026-11-27 基线(路径 ⇒ 直接写 Scan 的处数)。只许减少。 */
const BASELINE: Record<string, number> = {
  // 唯一作者自己
  "lib/aws/read-all.ts": 1,
  // 有意只取有限条(带 Limit):运行流水 / 事件 / 问数历史的近似取样,数据源的字段采样。不是「列出全部」
  "lib/alerting/evaluate.ts": 1,
  "lib/alerting/events.ts": 1,
  "lib/alerting/ops-summary.ts": 1,
  "lib/baseline/learn.ts": 1,
  "lib/copilot/tools/read-tools.ts": 2,
  "lib/datasource-spi/nosql/dynamodb.ts": 1,
  "lib/finops/advice.ts": 1,
  "lib/genbi/history.ts": 1,
  // 自己在跟下一页(早于唯一作者写的;行为等价,改不改都行)
  "app/api/monitor/runs/route.ts": 1,
  "lib/backfill/due.ts": 1,
  "lib/datasource/network-objects.ts": 1,
  "lib/datasource/network-sweep.ts": 1,
  "lib/datasource/placement.ts": 1,
  "lib/datasource/references.ts": 1,
  "lib/exec-env/delete-impact.ts": 1,
  "lib/finops/store.ts": 1,
  "lib/finops/sweep.ts": 1,
  "lib/governance/sensitive/scan.ts": 1,
  "lib/lake/routes.ts": 1,
  "lib/monitor/run-object-name.ts": 1,
  "lib/projects/project-resources.ts": 1,
  "lib/realtime/dms-instance-reclaim-job.ts": 1,
  "lib/scope/resource-index.ts": 1,
  "lib/workflow/job-references.ts": 1,
};

/** 「自己在跟下一页」的那一组:文件里必须真的有起读位置与下一页两个字样(不是只登记个名字)。 */
const OWN_PAGING = [
  "app/api/monitor/runs/route.ts", "lib/backfill/due.ts", "lib/datasource/network-objects.ts", "lib/datasource/network-sweep.ts", "lib/datasource/placement.ts",
  "lib/datasource/references.ts", "lib/exec-env/delete-impact.ts", "lib/finops/store.ts", "lib/finops/sweep.ts", "lib/governance/sensitive/scan.ts", "lib/lake/routes.ts",
  "lib/monitor/run-object-name.ts", "lib/projects/project-resources.ts", "lib/realtime/dms-instance-reclaim-job.ts", "lib/scope/resource-index.ts", "lib/workflow/job-references.ts",
];

/** 「有意只取有限条」的那一组:每一处直接写的 Scan 都带着 Limit。 */
const LIMITED = [
  "lib/alerting/evaluate.ts", "lib/alerting/events.ts", "lib/alerting/ops-summary.ts", "lib/baseline/learn.ts", "lib/copilot/tools/read-tools.ts",
  "lib/datasource-spi/nosql/dynamodb.ts", "lib/finops/advice.ts", "lib/genbi/history.ts",
];

/** 本批已改:「列出全部」的读取,必须调用唯一作者(文件 ⇒ 至少几处调用)。 */
const READS_ALL: Record<string, { fn: "scanAll" | "queryAll"; atLeast: number }> = {
  "app/api/etl-jobs/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/engines/[engine]/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/workflow/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/redshift/tasks/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/sync/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/flink/jobs/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/datasources/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/backfill/targets/route.ts": { fn: "scanAll", atLeast: 1 },
  "app/api/governance/impact/route.ts": { fn: "scanAll", atLeast: 2 },
  "lib/env/promote-service.ts": { fn: "scanAll", atLeast: 1 },
  "lib/projects/project-service.ts": { fn: "scanAll", atLeast: 1 },
  "lib/baseline/learn.ts": { fn: "scanAll", atLeast: 1 },
  "lib/governance/classification.ts": { fn: "scanAll", atLeast: 1 },
  "lib/governance/health-service.ts": { fn: "scanAll", atLeast: 2 },
  "lib/governance/lineage-service.ts": { fn: "scanAll", atLeast: 3 },
  "lib/realtime/flink-connectors.ts": { fn: "scanAll", atLeast: 1 },
  "lib/bi/analysis.ts": { fn: "queryAll", atLeast: 1 },
  "lib/bi/dashboards.ts": { fn: "queryAll", atLeast: 1 },
  "lib/bi/reports.ts": { fn: "queryAll", atLeast: 1 },
  "lib/versions/version-service.ts": { fn: "queryAll", atLeast: 1 },
};

describe("🔴 「列出全部」的读取要读到完为止:直接写 Scan 的地方只减不增", () => {
  const found: Record<string, number> = {};
  for (const f of FILES) {
    const n = countOf(readFileSync(f, "utf8"), /new ScanCommand\(/g);
    if (n) found[rel(f)] = n;
  }

  it("扫得到东西:产品源文件不少于 300 个;唯一作者在、里面有 Scan 与 Query 各一处", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(300);
    const author = readFileSync(resolve(SRC, "lib/aws/read-all.ts"), "utf8");
    expect(countOf(author, /new ScanCommand\(/g)).toBe(1);
    expect(countOf(author, /new QueryCommand\(/g)).toBe(1);
    expect(countOf(author, /LastEvaluatedKey/g)).toBeGreaterThanOrEqual(2);
  });

  it("没有基线之外的文件直接写 Scan(新写的「列出全部」用 scanAll;确实只要有限条的,登记进基线并写明)", () => {
    const extra = Object.keys(found).filter((f) => !(f in BASELINE)).sort();
    expect(extra, "这些文件直接写了 Scan 却不在基线里").toEqual([]);
  });

  it("基线里每个文件直接写 Scan 的处数不超过登记的数;已经不写的要从基线里删掉(不留死登记)", () => {
    const over = Object.entries(found).filter(([f, n]) => f in BASELINE && n > BASELINE[f]).map(([f, n]) => `${f}: ${n} > ${BASELINE[f]}`);
    expect(over).toEqual([]);
    const dead = Object.keys(BASELINE).filter((f) => !(f in found)).sort();
    expect(dead, "这些文件已经不直接写 Scan,基线可以删了").toEqual([]);
  });

  it("登记为「自己在跟下一页」的文件里真的有起读位置与下一页;登记为「有意只取有限条」的每一处 Scan 都带 Limit", () => {
    for (const f of OWN_PAGING) {
      const src = readFileSync(resolve(SRC, f), "utf8");
      expect(/ExclusiveStartKey/.test(src) && /LastEvaluatedKey/.test(src), `${f} 里没有翻页`).toBe(true);
    }
    for (const f of LIMITED) {
      const src = readFileSync(resolve(SRC, f), "utf8");
      // 每一处 Scan 的参数对象就在它后面的几行里:往后 450 个字符之内要有 Limit
      const scans = src.split("new ScanCommand(").slice(1);
      const withLimit = scans.filter((rest) => /\bLimit:/.test(rest.slice(0, 450)));
      expect(withLimit.length, `${f} 里有不带 Limit 的 Scan`).toBe(BASELINE[f]);
    }
    expect([...OWN_PAGING, ...LIMITED, "lib/aws/read-all.ts"].sort()).toEqual(Object.keys(BASELINE).sort());
  });

  it("已改的列表读取都真的调用了唯一作者(有调用,不只是 import),而且不再直接写单次读取", () => {
    for (const [f, want] of Object.entries(READS_ALL)) {
      const src = readFileSync(resolve(SRC, f), "utf8");
      const calls = countOf(src, new RegExp(`(?<!function )\\b${want.fn}(?:<[^>(]*>)?\\(`, "g"));
      expect(calls, `${f} 里 ${want.fn} 的调用处数`).toBeGreaterThanOrEqual(want.atLeast);
      expect(new RegExp(`import \\{[^}]*\\b${want.fn}\\b[^}]*\\} from "@/lib/aws/read-all"`).test(src), `${f} 没有从唯一作者引入 ${want.fn}`).toBe(true);
    }
  });
});
