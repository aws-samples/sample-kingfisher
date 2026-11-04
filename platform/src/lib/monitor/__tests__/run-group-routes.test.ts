// @kf-batch 50-WP5-rungroup
// §2.7 四个端点的**形状门禁**(50 SPEC v3.44 §2.7;判据 E-160/E-162/E-163/E-166)。
//
// 🔴 为什么是文本门禁而不是跑起来:这些 route 要 mock 掉 guard / Cognito / DDB / 审计一整串才能跑,
//    mock 一多就在测 mock;而「有没有走守卫」「有没有把已终态也送去取消」「有没有自己扇出」
//    都是能机械识别的形状(与 run-group.ts 的接线门禁同一手法)。真行为由 run-cancel / run-groups
//    两个**装配层**文件覆盖。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

const GROUP_ROUTES = [
  "app/api/run-groups/[id]/route.ts",
  "app/api/run-groups/[id]/cancel/route.ts",
  "app/api/run-groups/[id]/retry-failed/route.ts",
];
const LIST_ROUTES = [
  "app/api/etl-jobs/[id]/run-groups/route.ts",
  "app/api/engines/[engine]/[id]/run-groups/route.ts",
  "app/api/workflow/[id]/run-groups/route.ts",
];

describe("🔴 §2.7 四个端点:权限一律回落既有守卫,不许自己发明", () => {
  for (const rel of GROUP_ROUTES) {
    it(`${rel} 走 loadRunGroupForRequest(它内部回落 guardResourceAccess)`, () => {
      const src = strip(read(rel));
      expect(src).toContain("loadRunGroupForRequest(req, params.id,");
      expect(src, "守卫返回的响应必须直接 return,不许继续往下跑").toContain("if (loaded instanceof NextResponse) return loaded;");
      expect(src, "组本身没有成员表 ⇒ 不许在路由里自己判权限").not.toContain("guardResourceAccess(");
    });
  }
  it("读用 viewer、两个写动作用 editor(读写权限口径不许弄反)", () => {
    expect(strip(read(GROUP_ROUTES[0]))).toContain('params.id, "viewer"');
    expect(strip(read(GROUP_ROUTES[1]))).toContain('params.id, "editor"');
    expect(strip(read(GROUP_ROUTES[2]))).toContain('params.id, "editor"');
  });

  it("`loadRunGroupForRequest` 自己:表名靠模块 14 的 getResourceMeta(不写 switch)+ 定义被删也如实回 404", () => {
    const src = strip(read("lib/monitor/run-group-http.ts"));
    expect(src).toContain("getResourceMeta(kind)");
    expect(src, "definitionKind 必须先校验值域,非法就不去读表").toContain("isResourceType(kind)");
    expect(src).toContain('reason: "definition-deleted"');
    expect(src, "权限必须回落既有守卫").toContain("guardResourceAccess(req, Item, role)");
  });
});

describe("🔴 GET /api/run-groups/[id]:只许显示派生值 + 不外泄后端原生标识", () => {
  const src = strip(read(GROUP_ROUTES[0]));
  it("回 derivedStatus,并把子行过 publicChild 投影", () => {
    expect(src).toContain("derivedStatus: view.derivedStatus");
    expect(src).toContain("view.children.map(publicChild)");
    expect(src, "🔴 直接把内部子行整包回出去会带出 statementId / JobRunId").not.toContain("children: view.children,");
  });
  it("平台不认识的子状态要如实带出(绝不静默)", () => {
    expect(src).toContain("unknownChildStatuses");
  });
});

describe("🔴 POST cancel:只动 running,已终态不连坐;逐 run 独立结果整体 200", () => {
  const src = strip(read(GROUP_ROUTES[1]));
  it("过滤只取 running 再送去取消", () => {
    expect(src).toContain('view.children.filter((c) => c.status === "running")');
    // 送进取消函数的只能是那批 running
    expect(src).toMatch(/running\.map\(\(c\) => cancelRunOnItsTarget\(/);
    expect(src, "🔴 把 view.children 整包送去取消 = 已终态也会被连坐").not.toMatch(/view\.children\.map\(\(c\) => cancelRunOnItsTarget/);
  });
  it("没有在跑的区 ⇒ 409(而不是回一个空结果假装取消了)", () => {
    expect(src).toContain('reason: "nothing-running"');
    expect(src).toContain("409");
  });
  it("整体 200 + 逐 run 结果 + 审计留痕", () => {
    expect(src).toContain("apiOk({ runGroupId: params.id, results: rows })");
    expect(src).toContain('recordAudit(req, "run-group.cancel"');
  });
});

describe("🔴 POST retry-failed:服务端算失败区、**不自己扇出**、原组一个字节不改", () => {
  const src = strip(read(GROUP_ROUTES[2]));
  it("失败区由服务端从子 run 算(客户端挑就可能把成功的区也重跑)", () => {
    expect(src).toContain('view.children.filter((c) => c.status === "failed")');
    expect(src, "跳过的区(压根没提交出 run)同样属于这次没跑成").toContain("view.group.skipped");
  });
  it("🔴 绝不在这里扇出(否则驻留同意 / 绑定校验 / 审计三段逻辑就有了第二个作者)", () => {
    for (const forbidden of ["runGlueScriptJob", "runRedshiftSqlJob", "getProvider(", "openRunGroup", "putRunRecord"]) {
      expect(src, `retry-failed 里出现了 ${forbidden} ⇒ 它开始自己跑作业了`).not.toContain(forbidden);
    }
    expect(src, "只回重试计划:调用方拿着它打原来那条运行路由").toContain("retryOfRunGroupId: params.id");
  });
  it("没有失败区 / 还在跑 ⇒ 各自 409(不许静默建一个空重试)", () => {
    expect(src).toContain('reason: "nothing-failed"');
    expect(src).toContain('reason: "still-running"');
  });
  it("🔴 原组只读:整个文件不许出现任何写组行的调用", () => {
    for (const w of ["recordAccepted", "recordSkipped", "UpdateCommand", "PutCommand"]) {
      expect(src, `retry-failed 出现了 ${w} ⇒ 可能就地改写了原组(E-162 明确要求原组不变)`).not.toContain(w);
    }
  });
});

describe("🔴 三条列表端点:走 GSI 不 Scan、限流有上界、单区不成组因此不会出现", () => {
  for (const rel of LIST_ROUTES) {
    it(rel, () => {
      const src = strip(read(rel));
      // 列表必须回**带派生状态**的那一版:回裸组行 ⇒ UI 只能显示表里的物化 status = 第二真值源泄漏到界面
      expect(src).toContain("listRunGroupViewsByDefinition(");
      expect(src, "回裸组行(不带派生)= UI 会显示缓存值").not.toMatch(/await listRunGroupsByDefinition\(/);
      expect(src, "🔴 Scan 在多组之后只回首页且不报错 = 静默漏数").not.toContain("ScanCommand");
      expect(src).toContain("guardResourceAccess(req, Item, \"viewer\")");
      // limit:非法/超界收敛到边界,而不是静默用默认值
      expect(src).toContain("Math.min(Math.floor(raw), MAX_LIMIT)");
      expect(src).toContain("MAX_LIMIT = 100");
    });
  }
});
