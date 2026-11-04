// @kf-batch 50-WP27-9cap-matrix
// 🔴🔴 **实时计算的「哪个区」必须处处由章派生** —— WP-27 把实时计算纳入能力矩阵后当场抓到的三处缺陷。
//
// 三处同一个病灶(记忆 `fanout-wrapper-erases-typed-rejection` / `unwired-code-is-unverified` 的形态:
// 「写了」≠「每条兄弟路径都接上了」):
//   ① `/api/flink/jobs/[id]/produce` 在**模块顶部**建了一个主控区 KinesisClient ⇒ 给非 home 的流作业
//      点「造数」时记录被 PutRecords 到**主控区**的同名流(或 ResourceNotFound),而页面照样回
//      「已注入 150 条」。这正是 `flink-place.ts` 头上写的最坏形态:应用跑在那个区、数据写回主控区。
//   ② 建源时 `provision` **在解析落点之前**跑 ⇒ 落点解析失败时流已经建好了:账号里留一条在计费、
//      平台侧无记录的孤儿流(而代码注释写的是「解析失败 400 什么都不建」)。
//   ③ 流的物理 region 取 `connection.region`(前端可随便传、缺省回落部署区),与章 `ownerTargetId`
//      **从不交叉核对** ⇒ 可造出「章说 usw2、流在 us-east-1」的源;实时作业的跨区检查看的是
//      `ownerTargetId`(它是 usw2 ⇒ 检查通过)⇒ 在 usw2 跑的作业去读 us-east-1 的流,链路每步都不报错。
//
// 判据形状:**行为**不是文案 —— 逐条断言「区从哪来、顺序谁先谁后、不一致时是否真的拒」。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/** 🔴 负向文本断言前必须**剥注释**:否则「注释里解释了那个旧写法」会被当成「旧写法还在」。 */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

describe("实时计算:区必须由章派生(WP-27 抓到的三处)", () => {
  const produce = code("app/api/flink/jobs/[id]/produce/route.ts");
  const dsRoute = code("app/api/datasources/route.ts");
  const clients = code("lib/exec-env/target-clients.ts");

  it("① 造数路由不许有模块级的主控区 Kinesis 客户端;必须按 place.region 取", () => {
    // 负向:模块顶部 new KinesisClient({ region: REGION }) 这种写法归零
    expect(produce, "造数路由里还有 new KinesisClient(…) ⇒ 它一定是某个固定区的客户端").not.toMatch(/new\s+KinesisClient\s*\(/);
    // 正向:区来自作业行上的章 → resolveFlinkPlace → 按 region 取客户端
    expect(produce).toContain("flinkJobTarget(job)");
    expect(produce).toContain("resolveFlinkPlace(jobTarget)");
    expect(produce).toContain("kinesisClientFor(place.region)");
  });

  it("① 章解析不出来时**拒**(409),不静默回落主控区", () => {
    expect(produce).toContain("TARGET_PUSHDOWN_UNAVAILABLE");
    // 拒的分支必须在真正发记录之前:否则「先写了再拒」等于没拒
    expect(produce.indexOf("TARGET_PUSHDOWN_UNAVAILABLE")).toBeLessThan(produce.indexOf("PutRecordsCommand("));
  });

  it("① 回执必须复述落点(护栏 2:多区下「造数成功」本身没有信息量)", () => {
    const okIdx = produce.lastIndexOf("apiOk(");
    expect(okIdx).toBeGreaterThan(0);
    const body = produce.slice(okIdx);
    expect(body).toContain("targetId: place.targetId");
    expect(body).toContain("region: place.region");
  });

  it("② 建源:落点解析**先于** provision(否则解析失败时已经留下一条在计费的孤儿流)", () => {
    const iPlace = dsRoute.indexOf("await resolveDsPlace(");
    const iProv = dsRoute.indexOf("await provider!.provision(");
    expect(iPlace, "非 JDBC 分支里找不到 resolveDsPlace ⇒ 判据空转").toBeGreaterThan(0);
    expect(iProv, "找不到 provision 调用 ⇒ 判据空转").toBeGreaterThan(0);
    expect(iPlace, "provision 还排在落点解析之前 ⇒ 「解析失败什么都不建」是假话").toBeLessThan(iProv);
  });

  it("③ 建源:物理 region 由**章**派生;显式传了不一致的 region 就拒", () => {
    // 派生:传给 provision 的连接袋里 region 被章覆盖
    expect(dsRoute).toContain("const placedConn = { ...conn, region: nonJdbcPlace.region }");
    expect(dsRoute).toContain("provider!.provision(placedConn)");
    // 拒:不一致 ⇒ 400 VALIDATION_FAILED,且拒在 provision 之前
    const iReject = dsRoute.indexOf("conn.region.trim() !== nonJdbcPlace.region");
    expect(iReject, "没有「连接里的 region 与章不一致就拒」这道检查").toBeGreaterThan(0);
    expect(iReject).toBeLessThan(dsRoute.indexOf("await provider!.provision("));
  });

  it("③ 负向:落库的连接袋不许再直接用前端给的 conn(必须是被章覆盖过的那个)", () => {
    // createNonJdbcSource 的第 4 个实参(连接袋)只能是 finalConn —— 它派生自 placedConn
    const m = /createNonJdbcSource\(\s*req,\s*ctx,\s*\{[^}]*\},\s*(\w+)/.exec(dsRoute);
    expect(m, "找不到 createNonJdbcSource 调用 ⇒ 判据空转").toBeTruthy();
    expect(m![1]).toBe("finalConn");
    expect(dsRoute).toContain("let finalConn = placedConn");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴🔴 **闭合式接线门:凡「接受 targetId 的实时计算函数」,每个调用点都必须真的传它**
  //
  // 2026-09-19 真环境抓到的第四、第五处(与前三处同族:落点参数在签名里、调用点没接上):
  //   ④ `reconcileFlinkStatus` 把落点算出来就扔了(`const ctx = await ctxFor(...)` 之后调的是
  //      `describeFlinkJob(job.jobId)`)⇒ 非 home 的作业永远拿主控区客户端去 Describe 别区的应用,
  //      ResourceNotFound 被 catch 吞掉 ⇒ 平台把它标成「AWS已删除」,而它在那个区 RUNNING。
  //      实证:usw2 的示范流作业 MSAF 侧 RUNNING,页面显示「AWS已删除」。
  //   ⑤ `buildFlinkIncidentContext` 的**三条取证路**(状态 / 指标 / 日志)都没传 ⇒ 非 home 作业的
  //      AI 诊断拿主控区证据下结论(「应用不存在 + 指标全 null + 日志为空」)⇒ 报告必然是错的。
  //
  // 🔴 判据形状:**不列举**某几个调用点(那就是下一次漏改的温床)—— 扫 `src` 下全部非测试 .ts,
  //   找这几个函数的每一次调用,要求实参个数 ≥ 需要落点的那一位。违规数必须是 0。
  // ══════════════════════════════════════════════════════════════════════════
  describe("闭合门:实时计算的落点参数,每个调用点都必须传", () => {
    /** 函数名 → 落点参数是第几个(1-based);调用时实参数量必须 ≥ 这个数。 */
    const NEED: Record<string, number> = {
      describeFlinkJob: 2,     // (jobId, targetId)
      flinkHealthMetrics: 2,   // (jobId, targetId)
      readFlinkLogs: 3,        // (jobId, limit, targetId)
      readFlinkResults: 3,     // (jobId, limit, targetId)
    };

    function allSourceFiles(dir: string, acc: string[] = []): string[] {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "__tests__") continue;
        const p = resolve(dir, e.name);
        if (e.isDirectory()) allSourceFiles(p, acc);
        else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) acc.push(p);
      }
      return acc;
    }

    /** 数一次调用的顶层实参个数(按括号深度切逗号;字符串里的逗号不算)。 */
    function argCount(src: string, openIdx: number): number {
      let depth = 1;
      let i = openIdx + 1;
      let args = 0;
      let seen = false;
      let quote = "";
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (quote) {
          if (ch === quote && src[i - 1] !== "\\") quote = "";
        } else if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
          seen = true;
        } else if ("([{".includes(ch)) {
          depth += 1;
          seen = true;
        } else if (")]}".includes(ch)) {
          depth -= 1;
          if (depth > 0) seen = true;
        } else if (ch === "," && depth === 1) {
          args += 1;
        } else if (!/\s/.test(ch)) {
          seen = true;
        }
        i += 1;
      }
      return seen ? args + 1 : 0;
    }

    const files = allSourceFiles(SRC);

    it("扫描面没失效(src 下有三位数以上的源文件)", () => {
      expect(files.length).toBeGreaterThan(100);
    });

    it("🔴 每个调用点都带落点参数(违规数必须为 0)", () => {
      const bad: string[] = [];
      for (const f of files) {
        // 🔴 **先剥注释**:否则「注释里引用了旧写法」会被当成「旧写法还在」——
        //   本判据第一版就这么假红过一次(我在 reconcileFlinkStatus 的注释里引用了
        //   `describeFlinkJob(job.jobId)` 这行旧代码)。剥法保持行号:注释换成等长空白。
        const src = readFileSync(f, "utf8")
          .split("\n")
          .map((l) => {
            const t = l.trim();
            if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
            const i = l.indexOf("//");
            return i >= 0 ? l.slice(0, i) : l;
          })
          .join("\n");
        for (const [fn, need] of Object.entries(NEED)) {
          const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
          for (const m of src.matchAll(re)) {
            const at = m.index! + m[0].length - 1;
            // 跳过定义本身(`export async function xxx(`)
            const before = src.slice(Math.max(0, m.index! - 40), m.index!);
            if (/function\s+$/.test(before)) continue;
            const n = argCount(src, at);
            if (n < need) {
              const line = src.slice(0, m.index!).split("\n").length;
              bad.push(`${f.slice(SRC.length + 1)}:${line} ${fn}(…) 只传了 ${n} 个实参,需要 ≥ ${need}(第 ${need} 位是落点)`);
            }
          }
        }
      }
      expect(bad, `这些调用点没传落点 ⇒ 非 home 的流作业会拿**主控区**的客户端去做事(状态/指标/日志全错):\n${bad.join("\n")}`).toEqual([]);
    });

    it("🔴 `deleted` 不许进读时对账的短路名单(推导出来的结论必须能被重新勘定)", () => {
      const svc = readFileSync(resolve(SRC, "lib/realtime/flink-service.ts"), "utf8");
      const m = /const RECONCILE_SHORT_CIRCUIT: FlinkDbStatus\[\] = \[([^\]]*)\]/.exec(svc);
      expect(m, "找不到 RECONCILE_SHORT_CIRCUIT ⇒ 判据空转").toBeTruthy();
      const list = Array.from(m![1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
      expect(list.sort()).toEqual(["draft", "error", "stopped"]);
      expect(list).not.toContain("deleted");
      // 并且对账真的用的是这份名单(不是又回去用 FLINK_TERMINAL)
      const body = svc.slice(svc.indexOf("export async function reconcileFlinkStatus"));
      const head = body.slice(0, body.indexOf("return { dbStatus: mapped"));
      expect(head).toContain("RECONCILE_SHORT_CIRCUIT.includes(prev as FlinkDbStatus)");
      expect(head).not.toContain("FLINK_TERMINAL.includes(prev as FlinkDbStatus)");
    });
  });

  it("客户端工厂:kinesisClientFor 按 region 缓存,且进了 __resetTargetClients(免得单测互相串状态)", () => {
    // @kf-batch 50-WP31-place-first-class —— 构造与缓存收到唯一工厂 lib/aws/clients.ts(按「服务|区」缓存、
    //   一处 clear);kinesisClientFor 只是薄委托。判据随之钉:委托到 kinesis 这一项 + 工厂里有它的装载 + reset 委托到工厂。
    expect(clients).toContain("export async function kinesisClientFor(region: string)");
    expect(clients).toMatch(/kinesisClientFor\(region: string\): Promise<\w+> \{\s*return regionalClient\("kinesis", region\);/);
    const factory = code("lib/aws/clients.ts");
    expect(factory).toContain('kinesis: async () => (await import("@aws-sdk/client-kinesis")).KinesisClient');
    expect(factory).toMatch(/const key = `\$\{service\}\|\$\{region\}`/);
    const reset = clients.slice(clients.indexOf("export function __resetTargetClients"));
    expect(reset, "缓存没进 __resetTargetClients ⇒ 换区的单测会读到上一次的客户端").toContain("__resetClients()");
    expect(factory.slice(factory.indexOf("export function __resetClients"))).toContain("caches.clear()");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-WP27-9cap-matrix
// 🔴 **「源流」这一列必须是它真正消费的那条流** —— 又一处「部署期快照 vs 运行期解析」。
//
// 真环境实测(2026-09-19,WP-27 把实时计算纳入矩阵后看见的):示范作业消费的是
// `bgp-showcase-home-rt`,而实时计算页的「源流」列写着 `bgp-flink-source` ——
// 那是建作业时存下来的 `process.env.FLINK_SOURCE_STREAM || "bgp-flink-source"`,
// 而平台**刻意不建固定流**(2026-07-26 拍板:流由数据源 provision 按需新建)⇒
// **那条流根本不存在**。界面在说一条不存在的流的名字,而它旁边的状态还写着「运行中」。
// ⇒ 读侧按唯一作者 `resolveKinesisStreamName` 派生;前端优先显示派生值,存量字段只作回落。
// ══════════════════════════════════════════════════════════════════════════════
describe("实时计算:「源流」必须是真正消费的那条(不是建作业时的快照)", () => {
  const listRoute = code("app/api/flink/jobs/route.ts");
  const page = code("app/realtime-compute/page.tsx");

  it("读侧用**唯一作者** resolveKinesisStreamName 派生,且只对 kinesis 源作业算", () => {
    expect(listRoute).toContain("resolveKinesisStreamName(it.sourceDatasourceId)");
    expect(listRoute).toContain("it.sourceStreamResolved =");
    // 只对 kinesis 源做(CDC / MSK 作业没有 Kinesis 流可言)
    expect(listRoute).toContain('if (it.sourceType && it.sourceType !== "kinesis") return;');
    // 派生失败不许把整个列表打挂(它只是显示)
    const seg = listRoute.slice(listRoute.indexOf("sourceStreamResolved"));
    expect(seg.slice(0, 200)).toMatch(/catch/);
  });

  it("🔴 页面两处(列表列 + 详情面板)都优先显示派生值", () => {
    expect(page).toContain("r.sourceStreamResolved || v");
    expect(page).toContain("detail.job.sourceStreamResolved || detail.job.sourceStream");
    // 负向:不许再有「只读快照」的写法
    expect(page).not.toContain('dataIndex: "sourceStream", render: (v: string) => <Tag>{v}</Tag>');
    expect(page).not.toContain("<Tag>{detail.job.sourceStream}</Tag>");
  });
});
