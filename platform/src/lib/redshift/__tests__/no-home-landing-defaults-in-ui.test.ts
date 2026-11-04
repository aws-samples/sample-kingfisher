// @kf-batch 50-WP7-sync-pushdown
// 门禁:**客户端不许拿 home 的落点常量 / 字面量当默认值**(WP-7 施工序 7 的 E-218 同族,归零棘轮)。
//
// 起因:段 `o4` 的页面级判据 E-218 在向导上抓到「非 home 源建任务,Table Bucket 仍回显主控区的
// `bgp-table-bucket`」。修完向导后一查,同一形状还散在四页:athena 编辑器预填主控区表桶的示例 SQL、
// 横幅写死 `bgp-table-bucket`;genbi / redshift 的工作组下拉以 `HOME_WORKGROUP` 打底、清单为空时用它充数;
// etl-jobs 的 Redshift 落点编辑框以 `HOME_WORKGROUP / HOME_DATABASE` 打底。
// 在 us-west-2 视角下,这些显示的全是**主控区的名字** —— 与 `/settings` 那次「硬撒谎」同一类:
// 界面上一份看着很正常、其实属于另一个区的值,照着它建东西必然失败或跨区。
//
// 规矩(与向导那笔一致,f90abcb):落点(workgroup / database / 表桶)的**唯一作者在服务端**
// (`resolveRedshiftBinding` / `resolveS3TablesPlace` 按执行目标的描述符解析);前端一律留空 = 自动解析,
// 清单类控件只显示服务端按 targetId 回的清单。客户端引用 home 常量 = 在前端造第二个落点真值源。
//
// 🔴 负向文本断言先按行剥注释(本仓红线):注释里提到旧写法不算命中。
// 🔴 `ALLOW` 是只减不增的棘轮(当前 **0**):想加一条,必须先在这里写清为什么那处非引 home 常量不可。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "core-dist" || name === ".next" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

// 按行剥注释:双斜线行、块注释的起始行 / 星号行 / 结束行、JSX 注释行(左花括号 + 块注释起始)。
const strip = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l))
    .join("\n");

/** 客户端面 = `src/app/**` 与 `src/components/**` 下的 .tsx(API 路由是 .ts,不在此列)。 */
const UI_FILES = [...walk(resolve(SRC, "app")), ...walk(resolve(SRC, "components"))];

const BANNED: Array<{ re: RegExp; why: string }> = [
  { re: /\bHOME_WORKGROUP\b/, why: "引用 home 的 workgroup 常量 HOME_WORKGROUP" },
  { re: /\bHOME_DATABASE\b/, why: "引用 home 的 database 常量 HOME_DATABASE" },
  { re: /bgp-table-bucket/, why: "写死 home 的表桶名 bgp-table-bucket" },
  { re: /["'`]bgp-workgroup["'`]/, why: "写死 home 的 workgroup 名 bgp-workgroup" },
];

/** 棘轮:只减不增。形如 `app/xxx/page.tsx` 的相对路径前缀。 */
const ALLOW: string[] = [];

describe("🔴 客户端不许拿 home 的落点常量 / 字面量当默认值(归零棘轮)", () => {
  it("扫描面非空(app/ 与 components/ 下的 .tsx 都在)", () => {
    expect(UI_FILES.length).toBeGreaterThan(50);
    expect(UI_FILES.some((f) => f.endsWith("app/sync/SyncTaskModal.tsx"))).toBe(true);
    expect(UI_FILES.some((f) => f.endsWith("app/athena/page.tsx"))).toBe(true);
  });

  it("app/ 与 components/ 下零命中(剥注释后)", () => {
    const hits: string[] = [];
    for (const f of UI_FILES) {
      const code = strip(readFileSync(f, "utf8"));
      const rel = relative(SRC, f);
      for (const b of BANNED) if (b.re.test(code)) hits.push(`${rel}: ${b.why}`);
    }
    const unexpected = hits.filter((h) => !ALLOW.some((a) => h.startsWith(a)));
    expect(unexpected, "客户端又出现 home 落点默认值 —— 留空让服务端按执行目标解析,别在前端造第二个真值源").toEqual([]);
  });

  it("棘轮只减不增:ALLOW 里的每一条都必须仍然命中(命中消失了就把它删掉)", () => {
    for (const a of ALLOW) {
      const f = UI_FILES.find((p) => relative(SRC, p) === a.split(":")[0]);
      expect(f, `ALLOW 里的 ${a} 已不存在,请从名单删除`).toBeTruthy();
    }
  });

  it("四个被修过的页面:工作组下拉不再用 home 常量充数,athena 不再预填主控区示例 SQL", () => {
    const genbi = strip(readFileSync(resolve(SRC, "app/genbi/page.tsx"), "utf8"));
    const redshift = strip(readFileSync(resolve(SRC, "app/redshift/page.tsx"), "utf8"));
    const etl = strip(readFileSync(resolve(SRC, "app/etl-jobs/page.tsx"), "utf8"));
    const athena = strip(readFileSync(resolve(SRC, "app/athena/page.tsx"), "utf8"));
    // 选中项只能来自服务端清单:清单到达后按「仍在清单里则保留,否则取第一个」收敛
    expect(genbi).toContain("names.includes(cur) ? cur : names[0]");
    expect(redshift).toContain("names.includes(cur) ? cur : names[0]");
    // 落点编辑框归零后再套作业自己的配置(不再把上一个作业的落点留在框里)
    expect(etl).toContain('setRsCfg({ workgroupName: "", database: "", ...(j.redshiftConfig || {}) })');
    // 示例 SQL 从当前执行目标的表树取第一张表,而不是写死桶名
    expect(athena).toContain("first.qualifiedName} LIMIT 100");
    expect(athena).not.toMatch(/useState\('SELECT \* FROM/);
  });

  // @kf-batch 50-WP7-sync-pushdown —— 真环境截图坐实的缺陷:切区后跨区 ListWorkgroups 在飞的几十秒里,
  // 页面**继续显示上一个区**的工作组与 Endpoint(顶栏写 us-west-2、值却是主控区的 `bgp-workgroup` /
  // `…us-east-1…`)。这是 `/settings` 那次「硬撒谎」同一类。⇒ 取清单前必须先清空。
  // 🔴 这条是**接线断言**(文本层),真正的行为判据是段 `o4` 的 E-218b(真页面整页扫 + 落定判据);
  //    两层都要有:文本层防它被改回去,行为层证明它在真环境成立。
  it("切执行目标时先清空工作组清单与选中项(不许继续显示上一个区的值)", () => {
    for (const rel of ["app/redshift/page.tsx", "app/genbi/page.tsx"]) {
      const src = strip(readFileSync(resolve(SRC, rel), "utf8"));
      const i = src.indexOf("const fetchWorkgroups");
      expect(i, `${rel} 里找不到 fetchWorkgroups`).toBeGreaterThan(-1);
      const head = src.slice(i, i + 600);
      const clearWg = head.indexOf("setWorkgroups([])");
      const clearSel = head.indexOf('setSelectedWg("")');
      const doFetch = head.indexOf("fetch(");
      expect(clearWg, `${rel}: fetchWorkgroups 没先清空清单`).toBeGreaterThan(-1);
      expect(clearSel, `${rel}: fetchWorkgroups 没先清空选中项`).toBeGreaterThan(-1);
      // 顺序也要对:清空必须在发请求**之前**(放后面等于没清)
      expect(clearWg, `${rel}: 清空清单写在了 fetch 之后`).toBeLessThan(doFetch);
      expect(clearSel, `${rel}: 清空选中项写在了 fetch 之后`).toBeLessThan(doFetch);
      // 🔴 还要**丢弃陈旧响应**:一次进站会并发发出「上一个区」与「当前区」两个清单请求(视角 effect
      //    比首屏渲染晚一拍),晚到的那份会赢 ⇒ 清空治不了,必须按序号丢掉不是最新那次的答案。
      const seqTake = head.indexOf("++wgReqSeq.current");
      expect(seqTake, `${rel}: fetchWorkgroups 没取请求序号`).toBeGreaterThan(-1);
      expect(seqTake, `${rel}: 请求序号要在 fetch 之前取`).toBeLessThan(doFetch);
      const body = src.slice(i, i + 1400);
      expect(body, `${rel}: 回调里没丢弃陈旧响应(seq !== wgReqSeq.current 就该 return)`)
        .toContain("if (seq !== wgReqSeq.current) return");
    }
  });
});
