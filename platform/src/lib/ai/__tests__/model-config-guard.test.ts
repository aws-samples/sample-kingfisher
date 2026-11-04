// 🔴 门禁(51 SPEC §6.4 (a)–(f);ACCEPTANCE M15 / M17 / M18 单测面)。
//
// 这些断言守的是「结构上不可能回到旧形态」,不是功能对不对(功能在各自的单测里):
//   (a) 9 消费点无一处再读模块加载期 modelId 常量(剥注释后 grep;每点必须 import invokeConverse/invokeAgent 且带自己的能力 key)
//   (b) probeOk 字面量类型:用 TypeScript 编译器 API 真编译两份靶(负向带 @ts-expect-error 必 0 诊断;去掉指令必恰 1 错)
//   (c) 写 ai-model#* 一律无 ttl(跑真 store 写路径,扫每条写命令)
//   (d) 缓存键含 targetId(Map 而非单例;第二个 targetId 不共用条目)
//   (e) gptTransportReady() 恒 false(数据就位也 false;源码函数体不读任何 flag)
//   (f) assertAgentCoreModelMeta 缺 / 不等即抛
//   (g):系列判定正则**唯一作者** = lib/ai/core/vendors.ts(51 SPEC §7.1)
//   (h):容器落点真接上(genbi agent.js / _runtime 的整形调用点、三个 core-dist/ai 产物、分发副本同源;D17 瞬态流错误重试一次 + 日志)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const mem = vi.hoisted(() => ({ db: null as unknown as import("@/lib/settings/__tests__/mem-ddb").MemDdb }));
vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("@/lib/settings/__tests__/mem-ddb");
  mem.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return { TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" }, docClient: { send: (cmd: any) => mem.db.send(cmd) } };
});

import { CAPABILITIES } from "../capabilities";
import { scopeKeyOf, resolveModelRuntime, _cacheKeysForTests, _resetModelCacheForTests } from "../model";
import { gptTransportReady, readTransportGate, _resetTransportCacheForTests } from "../transport-gate";
import { assertAgentCoreModelMeta, AgentCoreModelMismatch } from "../agentcore-contract";
import { putGlobalModel, putProbe, putTransport, deleteModelSetting } from "@/lib/settings/model-store";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const PLATFORM = resolve(SRC, "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
// 剥掉行注释与块注释(负向文本断言前必先剥注释 —— 本仓历史教训)。
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

beforeEach(() => {
  mem.db.reset();
  _resetModelCacheForTests();
  _resetTransportCacheForTests();
});

// ── (a) 9 消费点 ────────────────────────────────────────────────────────────────
const CONSUMERS: { file: string; capability: (typeof CAPABILITIES)[number]; entry: "invokeConverse" | "invokeAgent" }[] = [
  { file: "lib/genbi/agent.ts", capability: "genbi", entry: "invokeConverse" },
  { file: "lib/genbi/retrieval.ts", capability: "genbi-retrieval", entry: "invokeConverse" },
  { file: "lib/genbi/memory.ts", capability: "genbi-memory", entry: "invokeConverse" },
  { file: "lib/copilot/agent.ts", capability: "copilot", entry: "invokeConverse" },
  { file: "lib/copilot/plan/planner.ts", capability: "copilot-planner", entry: "invokeAgent" },
  { file: "lib/network-advisor/advisor-agent.ts", capability: "net-advisor", entry: "invokeConverse" },
  { file: "lib/param-advisor/index.ts", capability: "param-advisor", entry: "invokeConverse" },
  { file: "lib/realtime/flink-sql-ai.ts", capability: "flink-sql", entry: "invokeConverse" },
  { file: "lib/requirements/codegen.ts", capability: "codegen", entry: "invokeConverse" },
];
const FORBIDDEN = [
  /modelId:\s*GENBI\.modelId/,
  /modelId:\s*COPILOT\.modelId/,
  /modelId:\s*NET_ADVISOR\.modelId/,
  /model:\s*GENBI\.modelId/, // flink-sql-ai:101 隐藏读取方
  /\bMODEL_ID\s*=\s*resolveModelId\(/, // memory.ts:17 / param-advisor:25 顶层常量
  /modelId:\s*MODEL_ID\b/,
  /\bresolveModelId\(\)/, // 消费点不许直接读同步解析(那是部署期快照)
];

describe("(a) 9 消费点零模块加载期 modelId 常量", () => {
  it("消费点清单与能力白名单一一对应(9 = 9)", () => {
    expect(CONSUMERS.map((c) => c.capability).sort()).toEqual([...CAPABILITIES].sort());
  });
  for (const c of CONSUMERS) {
    it(`${c.file} 不读模块加载期常量,且经 ${c.entry}("${c.capability}") 求值`, () => {
      const code = stripComments(read(c.file));
      for (const re of FORBIDDEN) expect(code, `${c.file} 命中禁用形态 ${re}`).not.toMatch(re);
      expect(code).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${c.entry}\\b[^}]*\\}\\s*from\\s*"@/lib/ai/invoke"`));
      expect(code).toMatch(new RegExp(`${c.entry}\\(\\s*"${c.capability}"`));
    });
  }
  it("3 个 config.ts 的 modelId 字段保留且标 @deprecated(不动对象形状)", () => {
    for (const f of ["lib/genbi/config.ts", "lib/copilot/config.ts", "lib/network-advisor/config.ts"]) {
      const code = read(f);
      expect(code).toMatch(/modelId:\s*resolveModelId\(\)/);
      expect(code).toMatch(/@deprecated/);
    }
  });
  it("lib/ai/model.ts 保留同步 resolveModelId 与 DEFAULT_MODEL_ID(部署期 / 兜底消费者继续用)", () => {
    const code = stripComments(read("lib/ai/model.ts"));
    expect(code).toMatch(/export const DEFAULT_MODEL_ID/);
    expect(code).toMatch(/export const resolveModelId = \(\): string => process\.env\.BEDROCK_MODEL_ID \|\| DEFAULT_MODEL_ID/);
  });
});

// ── (b) probeOk 字面量类型:真编译靶 ─────────────────────────────────────────────
describe("(b) probeOk: true 字面量类型 —— @ts-expect-error 靶(M15)", () => {
  const FIX = resolve(HERE, "fixtures");
  const negative = resolve(FIX, "probe-ok-literal.negative.ts");
  const positive = resolve(FIX, "probe-ok-literal.positive.ts");

  function compile(files: string[]) {
    const cfgPath = resolve(PLATFORM, "tsconfig.json");
    const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
    expect(cfg.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, PLATFORM, undefined, cfgPath);
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true, incremental: false, tsBuildInfoFile: undefined, plugins: undefined };
    const program = ts.createProgram(files, options);
    const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file && files.includes(d.file.fileName));
    return diags.map((d) => ({ code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, "\n"), file: d.file!.fileName }));
  }

  it("负向靶(带 @ts-expect-error)与正向靶都 0 诊断 —— 说明 ok:false 那一行确实被类型系统拒了", () => {
    expect(existsSync(negative) && existsSync(positive)).toBe(true);
    const diags = compile([negative, positive]);
    expect(diags, JSON.stringify(diags, null, 2)).toEqual([]);
  }, 120_000);

  it("对照:去掉 @ts-expect-error ⇒ 恰好 1 个类型错误(TS2322/TS2345),证明靶不是「什么都不报」的假绿", () => {
    const src = readFileSync(negative, "utf8").replace(/^\s*\/\/ @ts-expect-error.*\n/m, "");
    expect(src).not.toMatch(/^\s*\/\/ @ts-expect-error/m); // 只删指令行;文件头注释里提到它的文字保留
    const control = resolve(FIX, "probe-ok-literal.control.tmp.ts");
    writeFileSync(control, src);
    try {
      const diags = compile([control]);
      expect(diags.length, JSON.stringify(diags, null, 2)).toBe(1);
      expect([2322, 2345]).toContain(diags[0].code);
      expect(diags[0].text).toMatch(/true|ProbeOk|ok/);
    } finally {
      unlinkSync(control);
    }
  }, 120_000);
});

// ── (c) ai-model#* 写入无 ttl ─────────────────────────────────────────────────────
describe("(c) 写 ai-model#* 一律不带 ttl(表级 TTL 会把配置静默删掉)", () => {
  it("跑全部写路径(putGlobalModel / putProbe / putTransport / deleteModelSetting),扫每条写命令", async () => {
    const actor = { actor: "admin" };
    await putGlobalModel({ scope: "global", modelId: "m1", probe: { ok: true }, actor });
    await putGlobalModel({ scope: "global", modelId: "m2", probe: { ok: true, toolUseOk: true }, actor, expectVersion: 1 });
    await putProbe("tgt_home", "m1", { ok: false, error: "Throttle", errorDetail: "x" });
    await putProbe("tgt_usw2_b", "m1", { ok: true, toolUseOk: true, quotaHint: "unknown" });
    await putTransport({ gptReady: false, branch: null, decidedAt: 1, decidedBy: "a" }, actor);
    await deleteModelSetting("global", actor);
    const writes = mem.db.log.filter((l) => ["PutCommand", "UpdateCommand", "TransactWriteCommand"].includes(l.cmd));
    expect(writes.length).toBeGreaterThanOrEqual(5);
    const items: Record<string, unknown>[] = [];
    for (const w of writes) {
      if (w.cmd === "PutCommand") items.push(w.input.Item);
      if (w.cmd === "UpdateCommand") items.push({ sk: w.input.Key?.sk, ...(w.input.ExpressionAttributeNames || {}) });
      if (w.cmd === "TransactWriteCommand") {
        for (const ti of w.input.TransactItems) {
          if (ti.Put) items.push(ti.Put.Item);
          if (ti.Update) items.push({ sk: ti.Update.Key?.sk, ...Object.fromEntries(Object.values(ti.Update.ExpressionAttributeNames || {}).map((n) => [n, 1])) });
        }
      }
    }
    const aiModelItems = items.filter((i) => typeof i.sk === "string" && (i.sk as string).startsWith("ai-model#"));
    expect(aiModelItems.length).toBeGreaterThanOrEqual(6);
    for (const it of aiModelItems) expect(Object.keys(it), `${String(it.sk)} 带了 ttl`).not.toContain("ttl");
    for (const row of mem.db.dump("bgp-settings")) if (String(row.sk).startsWith("ai-model#")) expect(Object.keys(row)).not.toContain("ttl");
  });
  it("源码层:store 的每个 ai-model#* 写路径都过 assertNoTtl", () => {
    const code = stripComments(read("lib/settings/model-store.ts"));
    expect((code.match(/assertNoTtl\(/g) || []).length).toBeGreaterThanOrEqual(4); // 定义 + putGlobalModel + putProbe + putTransport
  });
});

// ── (d) 缓存键含 targetId ─────────────────────────────────────────────────────────
describe("(d) 缓存按 <targetId>#<capability> 定形(Map 而非单例;M18)", () => {
  it("scopeKeyOf 含 targetId;两个 target 两条缓存条目", async () => {
    expect(scopeKeyOf("genbi", "tgt_usw2_b")).toBe("tgt_usw2_b#genbi");
    expect(scopeKeyOf("genbi", "tgt_home")).toBe("tgt_home#genbi");
    expect(scopeKeyOf("genbi")).toBe("tgt_home#genbi");
    await resolveModelRuntime("genbi", "tgt_home", 1);
    await resolveModelRuntime("genbi", "tgt_usw2_b", 1);
    await resolveModelRuntime("codegen", "tgt_usw2_b", 1);
    expect(new Set(_cacheKeysForTests()).size).toBe(3);
    expect(_cacheKeysForTests().every((k) => k.startsWith("tgt_"))).toBe(true);
  });
  it("源码层:没有把键钉死成字面量类型的写法(sk: typeof GLOBAL_MODEL_SK 之类)", () => {
    const code = stripComments(read("lib/settings/model-store.ts"));
    expect(code).not.toMatch(/sk:\s*typeof\s+\w*SK/);
    expect(stripComments(read("lib/ai/model.ts"))).toMatch(/new Map<string, CacheHit>/);
  });
});

// ── (e) gptTransportReady 恒 false ────────────────────────────────────────────────
describe("(e) gptTransportReady() 本波恒 false(M13a)", () => {
  it("数据就位(真实现为 true)硬闸仍 false", async () => {
    await putTransport({ gptReady: true, branch: "A", decidedAt: Date.now(), decidedBy: "a", probeModelId: "openai.gpt-5.6-sol", probedAt: Date.now() }, { actor: "a" });
    _resetTransportCacheForTests();
    expect(await readTransportGate()).toBe(true);
    expect(await gptTransportReady()).toBe(false);
  });
  it("源码层:gptTransportReady 函数体不读 DDB / env / flag(只有 return false)", () => {
    const code = stripComments(read("lib/ai/transport-gate.ts"));
    const m = code.match(/export async function gptTransportReady\(\)[^{]*\{([\s\S]*?)\n\}/);
    expect(m).toBeTruthy();
    const body = m![1].trim();
    expect(body).toBe("return false;");
  });
});

// ── (g) 系列正则唯一作者 ──────────────────────────────────────────────────────────
describe("(g) 系列判定正则只许出现在 lib/ai/core/vendors.ts(51 SPEC §7.1)", () => {
  const SERIES_PATTERNS = [
    /anthropic\\\.claude-opus-/, // 正则字面量 anthropic\.claude-opus-
    /openai\\\.gpt-5\\\.6-/,
    /zai\\\.glm-5/,
    /moonshotai\\\.kimi-k3/,
    /\(\?:anthropic\|openai\)/, // 旧地理前缀正则的厂商枚举
  ];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  it("platform/src 下除 vendors.ts 外无第二份系列正则(剥注释后扫)", () => {
    const vendors = resolve(SRC, "lib/ai/core/vendors.ts");
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (f === vendors) continue;
      const code = stripComments(readFileSync(f, "utf8"));
      for (const re of SERIES_PATTERNS) if (re.test(code)) offenders.push(`${f.replace(SRC + "/", "")} ← ${re}`);
    }
    expect(offenders).toEqual([]);
    const v = stripComments(readFileSync(vendors, "utf8"));
    expect(v).toMatch(/anthropic\\\.claude-opus-/);
    expect(v).toMatch(/moonshotai\\\.kimi-k3/);
  });
  it("scripts/resolve-home-model.sh 不再写厂商正则:基础模型按 list-inference-profiles 的 modelArn 真值匹配", () => {
    const sh = readFileSync(resolve(PLATFORM, "../scripts/resolve-home-model.sh"), "utf8");
    expect(sh).toContain("modelArn");
    expect(sh).toContain("candidateModelIds");
    expect(sh).not.toMatch(/anthropic\|openai/);
  });
});

// ── (h) 容器落点接上了 ────────────────────────────────────────────────────────────
describe("(h) 容器侧整形真接上(「写了」≠「接上了」):调用点 + 产物 + 分发同源", () => {
  const AGENT = resolve(PLATFORM, "../infra/agent");
  it("genbi agent.js:import core-dist/ai/converse-shape 且检索重排 ModelClient 与 Strands maxTokens 都经 shapeInferenceConfig、学习 + 重试一次", () => {
    const code = stripComments(readFileSync(resolve(AGENT, "genbi/agent.js"), "utf8"));
    expect(code).toMatch(/from "\.\/core-dist\/ai\/converse-shape\.js"/);
    expect((code.match(/shapeInferenceConfig\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(code).toMatch(/learnUnsupportedField\(MODEL_ID, e\)/);
    expect(code).not.toMatch(/inferenceConfig:\s*\{\s*maxTokens:\s*maxTokens \|\| 1000,\s*temperature/); // 旧的直拼形态不许回来
  });
  it("_runtime/agent-runner.js:按容器内布局 import ../core-dist/ai,BedrockModel maxTokens 经系数", () => {
    const code = stripComments(readFileSync(resolve(AGENT, "_runtime/agent-runner.js"), "utf8"));
    expect(code).toMatch(/from "\.\.\/core-dist\/ai\/converse-shape\.js"/);
    expect(code).toMatch(/maxTokens:\s*shapeInferenceConfig\(MODEL_ID, \{ maxTokens \}\)\.config\.maxTokens/);
  });
  it("三个容器的 core-dist/ai 产物在且含四系列;netadvisor / paramadvisor 的 _runtime 副本与共享源逐字节相同", () => {
    for (const c of ["genbi", "netadvisor", "paramadvisor"]) {
      const js = readFileSync(resolve(AGENT, c, "core-dist/ai/vendors.js"), "utf8");
      for (const fam of ["anthropic", "openai", "zai", "moonshotai"]) expect(js, `${c} core-dist/ai 缺 ${fam}`).toContain(fam);
      expect(existsSync(resolve(AGENT, c, "core-dist/ai/converse-shape.js"))).toBe(true);
      expect(JSON.parse(readFileSync(resolve(AGENT, c, "core-dist/ai/package.json"), "utf8")).type).toBe("commonjs");
    }
    const src = readFileSync(resolve(AGENT, "_runtime/agent-runner.js"), "utf8");
    for (const c of ["netadvisor", "paramadvisor"]) expect(readFileSync(resolve(AGENT, c, "_runtime/agent-runner.js"), "utf8")).toBe(src);
  });
  // 2026-10-14 …7698 真环境:Kimi K3 下问数容器第 6 轮模型调用「Stream ended without completing a message」,
  //   容器 catch 静默吞错、不重试。这里钉:两处容器都 import 同一份 transient 清单、留结构化日志、瞬态**只**重试一次、Agent 由工厂重建且历史浅拷贝。
  it("D17:genbi agent.js 与 _runtime/agent-runner.js 都接上 core-dist/ai/transient(判定 + 有界退避 + 日志),Agent 走工厂、重试上限是常量不是字面量", () => {
    const genbi = stripComments(readFileSync(resolve(AGENT, "genbi/agent.js"), "utf8"));
    const runner = stripComments(readFileSync(resolve(AGENT, "_runtime/agent-runner.js"), "utf8"));
    expect(genbi).toMatch(/import \{ describeModelError, TRANSIENT_MAX_RETRIES, transientBackoffMs \} from "\.\/core-dist\/ai\/transient\.js"/);
    expect(runner).toMatch(/import \{ describeModelError, TRANSIENT_MAX_RETRIES, transientBackoffMs \} from "\.\.\/core-dist\/ai\/transient\.js"/);
    for (const [name, code] of [["genbi", genbi], ["runner", runner]] as const) {
      expect(code, `${name}: Agent 必须由工厂建(重试要重建)`).toMatch(/const mkAgent = \(\) => new Agent\(\{/);
      expect(code, `${name}: 历史浅拷贝`).toMatch(/messages:\s*\[\.\.\.messages\]/);
      expect(code, `${name}: 调用点`).toMatch(/result = await mkAgent\(\)\.invoke\(/);
      expect(code, `${name}: 先描述再决定`).toMatch(/const d = describeModelError\(e\);/);
      expect(code, `${name}: 瞬态且未超上限才重试`).toMatch(/if \(d\.transient && attempt < TRANSIENT_MAX_RETRIES\)/);
      expect(code, `${name}: 退避按 attempt 抖动`).toMatch(/transientBackoffMs\(attempt\)/);
      expect(code, `${name}: 必留日志`).toMatch(/console\.error\(/);
      expect(code, `${name}: 不许写死重试次数`).not.toMatch(/attempt < [0-9]/);
      expect((code.match(/new Agent\(\{/g) || []).length, `${name}: 只能有工厂这一处 new Agent`).toBe(1);
    }
    expect(genbi).toMatch(/tag: "agent-error", capability: "genbi", modelId: MODEL_ID, attempt/);
    for (const c of ["genbi", "netadvisor", "paramadvisor"]) {
      expect(existsSync(resolve(AGENT, c, "core-dist/ai/transient.js")), `${c} core-dist/ai 缺 transient.js(跑 scripts/core-prebuild.sh ai)`).toBe(true);
      const js = readFileSync(resolve(AGENT, c, "core-dist/ai/transient.js"), "utf8");
      expect(js).toContain("Stream ended without completing a message");
      expect(js).toMatch(/TRANSIENT_MAX_RETRIES = 1/);
    }
    // tsconfig 带注释(JSONC),不能 JSON.parse;钉 include 行里有它
    const tsconfig = readFileSync(resolve(PLATFORM, "tsconfig.ai-core.json"), "utf8");
    expect(tsconfig).toMatch(/"include":\s*\[[^\]]*"src\/lib\/ai\/core\/transient\.ts"/);
  });
  it("core-prebuild.sh 注册了 ai 能力,且 all 的显式顺序以 ai 收尾(三个容器 core-dist 先重建,ai 子目录后填)", () => {
    const sh = readFileSync(resolve(PLATFORM, "../scripts/core-prebuild.sh"), "utf8");
    expect(sh).toMatch(/\[ai\]="tsconfig\.ai-core\.json"/);
    expect(sh).toMatch(/for CAP in genbi paramadvisor netadvisor cookbook ai; do build_one/);
    expect(existsSync(resolve(PLATFORM, "tsconfig.ai-core.json"))).toBe(true);
  });
});

// ── (f) AgentCore 回执校验 ────────────────────────────────────────────────────────
describe("(f) assertAgentCoreModelMeta 缺 / 不等即抛(M17)", () => {
  it("缺 _meta ⇒ 抛;不等 ⇒ 抛;等 ⇒ 通过", () => {
    expect(() => assertAgentCoreModelMeta({ answer: "x" }, "m1", "genbi")).toThrow(AgentCoreModelMismatch);
    expect(() => assertAgentCoreModelMeta({ _meta: { modelId: "m2" } }, "m1", "genbi")).toThrow(AgentCoreModelMismatch);
    expect(assertAgentCoreModelMeta({ _meta: { modelId: "m1" } }, "m1", "genbi")).toBe("m1");
  });
  it("源码层:三个本仓有容器的 client 都断言回执;三个调用方都不把 Mismatch 吞进 inprocess 回落", () => {
    for (const f of ["lib/genbi/agentcore-client.ts", "lib/network-advisor/agentcore-client.ts", "lib/param-advisor/agentcore-client.ts"]) {
      expect(stripComments(read(f))).toMatch(/assertAgentCoreModelMeta\(/);
    }
    for (const f of ["lib/genbi/execute.ts", "lib/network-advisor/index.ts", "lib/param-advisor/index.ts"]) {
      expect(stripComments(read(f))).toMatch(/if \(e instanceof AgentCoreModelMismatch\) throw e;/);
    }
    // 容器共享源:读 payload.modelId ‖ env,不再有手抄兜底字面量;回显 _meta。
    const runner = stripComments(readFileSync(resolve(PLATFORM, "../infra/agent/_runtime/agent-runner.js"), "utf8"));
    const genbi = stripComments(readFileSync(resolve(PLATFORM, "../infra/agent/genbi/agent.js"), "utf8"));
    for (const code of [runner, genbi]) {
      expect(code).not.toMatch(/claude-sonnet-4-5/);
      expect(code).toMatch(/input\.modelId/);
      expect(code).toMatch(/_meta/);
    }
  });
});
