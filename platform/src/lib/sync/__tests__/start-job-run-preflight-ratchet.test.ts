// 序 61 B-133 —— 棘轮:凡是会起 Glue 作业的 TS 入口,起作业之前必须经数据源外部网络对象的核对自愈(唯一作者 lib/datasource/network-reconcile.ts)。
//
// 「写了」≠「接上了」:核对函数再完整,少接一个 StartJobRun 入口就是一条仍会给用户 AWS 原话的路。本判据钉三件事:
//   ① 全仓 lib 下含 `StartJobRunCommand` 的文件 == 封闭清单(新冒出一个入口 ⇒ 红,来这里登记并决定要不要接);
//   ② 依赖数据源 Glue 连接的三个入口(同步启动核心 / 发现作业 / 调度扇出)都 import 了核对作者;
//   ③ 在各自的函数体里,核对调用**文本上先于**第一个副作用 / 起作业(不是只有 import)。
// 不经 TS 的路径(MWAA Serverless 的 Python 运行时直接 start_job_run)由泵巡检 lib/datasource/network-sweep.ts 覆盖,
//   本判据同时钉它挂在 sweep 路由上。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "__tests__" && e !== "node_modules") walk(p, out); }
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 起 Glue 作业的 TS 入口(封闭清单)。前三个依赖数据源的 Glue 连接 ⇒ 必须接核对;后三个不依赖数据源网络对象(离线作业 / 造数 / EMR)。 */
const START_JOB_RUN_FILES = [
  "lib/sync/start-run.ts",
  "lib/datasource/glue-reach.ts",
  "lib/scheduler/dependency.ts",
  "lib/etl/job-service.ts",
  "lib/seed/run-once.ts",
  "lib/engines/emr/provider.ts",
].sort();
const DATASOURCE_DEPENDENT = START_JOB_RUN_FILES.slice(0, 0).concat(["lib/sync/start-run.ts", "lib/datasource/glue-reach.ts", "lib/scheduler/dependency.ts"]);

/** 取某个 `export async function <name>(` 到下一个顶层 `export` 之间的源码(函数体近似) */
function bodyOf(src: string, fnName: string): string {
  const start = src.indexOf(`async function ${fnName}(`);
  expect(start, `找不到函数 ${fnName}`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(export )?(async )?function |\nexport (const|type|interface|class) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("B-133 棘轮:StartJobRun 入口封闭 + 三个数据源入口先核对再起作业", () => {
  it("① lib 下含 StartJobRunCommand 的文件 == 封闭清单", () => {
    const files = walk(resolve(SRC, "lib"))
      .filter((p) => readFileSync(p, "utf8").includes("StartJobRunCommand"))
      .map((p) => p.slice(SRC.length + 1).split("\\").join("/"))
      .sort();
    expect(files).toEqual(START_JOB_RUN_FILES);
  });

  it.each(DATASOURCE_DEPENDENT)("② %s import 了 network-reconcile 并真调用 reconcileDatasourceNetwork(", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/import \{[^}]*\breconcileDatasourceNetwork\b[^}]*\} from "@\/lib\/datasource\/network-reconcile"/);
    expect(src).toMatch(/\bawait reconcileDatasourceNetwork\(/);
  });

  it("③ start-run.ts:ensureGlueSyncJob 里核对先于写脚本桶 / 建作业,且 broken ⇒ 409 DATASOURCE_NETWORK_BROKEN;pollGlueJob 终态过 classifyRunError", () => {
    const src = read("lib/sync/start-run.ts");
    const body = bodyOf(src, "ensureGlueSyncJob");
    const rec = body.indexOf("await reconcileDatasourceNetwork(");
    expect(rec).toBeGreaterThan(-1);
    expect(rec).toBeLessThan(body.indexOf("new PutObjectCommand("));
    expect(rec).toBeLessThan(body.indexOf("await upsertGlueJob("));
    expect(rec).toBeLessThan(body.indexOf("await ensureS3TableBucketAndNamespace("));
    expect(body).toMatch(/net\.kind === "broken"\) return ensureReject\(409, net\.message, "DATASOURCE_NETWORK_BROKEN"\)/);
    const poll = bodyOf(src, "pollGlueJob");
    expect(poll).toMatch(/classifyRunError\(JobRun\.ErrorMessage\)/);
    expect(poll).toMatch(/noteNetworkDriftFromRunError\(/);
    expect(poll).toMatch(/errorRaw: JobRun\.ErrorMessage/);
  });

  it("③ glue-reach.ts:startDiscovery 里核对先于写脚本桶与 StartJobRun,broken ⇒ 抛 DatasourceNetworkBrokenError;reachability-probe 捕获它", () => {
    const src = read("lib/datasource/glue-reach.ts");
    const body = bodyOf(src, "startDiscovery");
    const rec = body.indexOf("await reconcileDatasourceNetwork(");
    expect(rec).toBeGreaterThan(-1);
    expect(rec).toBeLessThan(body.indexOf("new PutObjectCommand("));
    expect(rec).toBeLessThan(body.indexOf("await startRunAdoptingConcurrent("));
    expect(body).toMatch(/throw new DatasourceNetworkBrokenError\(net\.issue\)/);
    const probe = read("lib/datasource/reachability-probe.ts");
    expect(probe).toMatch(/e instanceof DatasourceNetworkBrokenError/);
    expect(probe).toMatch(/await writeHeartbeat\(row\.datasourceId, "error", hb\)/);
  });

  it("③ dependency.ts:startDownstreamSync 里核对先于 StartJobRun,broken ⇒ 落 failed 运行行后 return", () => {
    const src = read("lib/scheduler/dependency.ts");
    const body = bodyOf(src, "startDownstreamSync");
    const rec = body.indexOf("await reconcileDatasourceNetwork(");
    expect(rec).toBeGreaterThan(-1);
    expect(rec).toBeLessThan(body.indexOf("new StartJobRunCommand("));
    expect(body).toMatch(/status: "failed"/);
    expect(body).toMatch(/errorKind: "datasource-network-broken"/);
  });

  it("④ 读时对账 reconcileGlue 同样分类终态原话;运行列表路由经 presentRunRow 呈现", () => {
    const rec = read("lib/sync/reconcile.ts");
    expect(rec).toMatch(/classifyRunError\(run\.ErrorMessage\)/);
    expect(rec).toMatch(/noteNetworkDriftFromRunError\(/);
    const route = read("app/api/sync/[id]/runs/route.ts");
    expect(route).toMatch(/Items\.map\(\(row\) => presentRunRow\(row\)\)/);
  });

  it("⑤ 不经 TS 的调度运行时路径由泵巡检覆盖:sweep 路由在 sweepAutoSupply 之后调 sweepDatasourceNetwork", () => {
    const route = read("app/api/internal/dataplane-jobs/sweep/route.ts");
    const a = route.indexOf("await sweepAutoSupply(");
    const b = route.indexOf("await sweepDatasourceNetwork(");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(read("lib/datasource/network-sweep.ts")).toMatch(/await reconcileDatasourceNetwork\(ds, \{ via: NETWORK_SWEEP_VIA \}\)/);
  });
});
