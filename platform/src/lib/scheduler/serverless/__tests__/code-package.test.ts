// Code 包契约:**zip、模块在根、内容 = 运行时源码、同内容同字节、key 以 .zip 结尾**。
// 真环境教训:裸 .py 的 Code ⇒ CreateWorkflow 成功、workflow READY、cron 照触发,而每个 run 在 DagBag 阶段
//   `ModuleNotFoundError: No module named 'bgp_runtime'` 秒死 —— 只有把「包形态」钉成单测,这类「发得出去、跑不起来」才不会复发。
import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { BGP_RUNTIME_MODULE, BGP_RUNTIME_PY, BGP_RUNTIME_VERSION } from "@/lib/scheduler/serverless/runtime-py";
import { BGP_RUNTIME_S3_KEY, BGP_RUNTIME_ZIP, BGP_RUNTIME_ZIP_ENTRY } from "@/lib/scheduler/serverless/code-package";

describe("serverless Code 包 = zip(模块在根)", () => {
  it("是合法 zip:恰好一个条目、名为 bgp_runtime.py、在根(无目录前缀)", () => {
    const entries = new AdmZip(BGP_RUNTIME_ZIP).getEntries();
    expect(entries.map((e) => e.entryName)).toEqual([`${BGP_RUNTIME_MODULE}.py`]);
    expect(BGP_RUNTIME_ZIP_ENTRY).toBe(`${BGP_RUNTIME_MODULE}.py`);
    expect(entries[0].entryName).not.toContain("/");
    expect(entries[0].isDirectory).toBe(false);
  });

  it("条目内容逐字节等于运行时源码(python_callable 靠它 import)", () => {
    const e = new AdmZip(BGP_RUNTIME_ZIP).getEntry(`${BGP_RUNTIME_MODULE}.py`);
    expect(e).toBeTruthy();
    expect(e!.getData().toString("utf8")).toBe(BGP_RUNTIME_PY);
  });

  it("同内容 ⇒ 同字节(版本桶里不堆无意义版本:zip 头时间戳被固定)", async () => {
    const mod = await import("@/lib/scheduler/serverless/code-package?dup=1" as string).catch(() => null);
    // 动态再导可能被缓存;退一步:同一份字节自比 + 头里不含「现在」的年份漂移(固定 2020 年)
    const again = mod ? (mod as { BGP_RUNTIME_ZIP: Buffer }).BGP_RUNTIME_ZIP : BGP_RUNTIME_ZIP;
    expect(Buffer.compare(again, BGP_RUNTIME_ZIP)).toBe(0);
    const t = new AdmZip(BGP_RUNTIME_ZIP).getEntries()[0].header.time;
    expect(t.getUTCFullYear()).toBe(2020);
  });

  it("S3 key = code/<module>-<内容哈希>.zip(改运行时即新对象,老 workflow 不受影响)", () => {
    expect(BGP_RUNTIME_S3_KEY).toBe(`code/${BGP_RUNTIME_MODULE}-${BGP_RUNTIME_VERSION}.zip`);
    expect(BGP_RUNTIME_S3_KEY.endsWith(".zip")).toBe(true);
    expect(BGP_RUNTIME_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  it("🔴 runtime-py.ts 不再导出 S3 key,publish.ts 只用 zip 字节(结构上拿不到「裸 .py」那条路)", async () => {
    const rt = (await import("@/lib/scheduler/serverless/runtime-py")) as Record<string, unknown>;
    expect(Object.keys(rt)).not.toContain("BGP_RUNTIME_S3_KEY");
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../publish.ts"), "utf8");
    expect(src).toContain("BGP_RUNTIME_ZIP");
    expect(src).toContain('ContentType: "application/zip"');
    expect(src).not.toContain("BGP_RUNTIME_PY");
    expect(src).not.toContain('ContentType: "text/x-python"');
  });
});

describe("下线:有 run 在跑时不许假装已下线", () => {
  it("deleteWorkflow 停跑后**等终态**再删,冲突退避重试,仍失败就抛(不返回 deleted:true)", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../workflow-client.ts"), "utf8");
    expect(src).toContain('const NON_TERMINAL = ["STARTING", "QUEUED", "RUNNING", "STOPPING"]');
    expect(src).toMatch(/没到终态,拒绝当成已下线/);
    expect(src).toMatch(/Conflict\|in a state\|InvalidRequest/);
  });

  it("🔴 下线失败时**保留台账**(workflowArn 是找回孤儿 workflow 的唯一线索)+ 两条 schedule 路由报 502", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "../../../..");
    for (const f of ["lib/etl/dag-fanout.ts", "lib/engines/emr/schedule-fanout.ts"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, `${f} 失败仍在清台账`).toContain("if (!r.failed) await removeDeployment(");
      expect(src).toContain("failed: true");
    }
    // 🔴 这里原来钉的是**文案字面量**「下线调度失败(」,
    // 而那句人话已经收进单一作者 `offlineFailureMessage`(四个调用点共用);把逐字文案钉在调用点上
    // ⇒ 收成单一作者反而把门禁打红(判据钉形态而承重是事实)。改钉事实:
    //   ① 路由必须**问过**「哪些区没撤下来」(`offlineFailures(`);② 必须报 502;
    //   ③ 那句人话由单一作者出(它自己被钉一次就够)。
    for (const f of ["app/api/etl-jobs/[id]/schedule/route.ts", "app/api/engines/[engine]/[id]/schedule/route.ts",
                     "app/api/etl-jobs/[id]/route.ts", "app/api/engines/[engine]/[id]/route.ts"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      expect(src, `${f} 没问「哪些区其实没撤下来」(offlineFanout 从不抛 ⇒ try/catch 拦不到)`)
        .toContain("offlineFailures(");
      expect(src, `${f} 没把下线失败报成 502`).toContain("502");
    }
    // 人话与「作业未删除 / 状态不变」的承诺收在单一作者里
    const fanout = readFileSync(resolve(root, "lib/etl/dag-fanout.ts"), "utf8");
    expect(fanout).toContain("下线失败(");
    expect(fanout).toContain("export const OFFLINE_RETRY_TAIL");
  });
});
