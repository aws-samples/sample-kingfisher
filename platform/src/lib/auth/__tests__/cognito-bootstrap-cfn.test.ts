/**
 * 建初始用户的三条路径的门禁。
 *
 * 🔴 为什么要有它:「建组建号」这件事同时长在**三处**——
 *   ① `infra/lib/auth-stack.ts` 的 `BOOTSTRAP_ROSTER`(写死进函数环境变量)
 *   ② `scripts/10-bootstrap-cognito.sh` 的 `USERS` / `GROUP`(路径A/B 的名册)
 *   ③ `infra/lambda/cognito-bootstrap/index.py`(执行者)
 * 三侧一致此前**只靠注释维持**(auth-stack.ts 里写着「必须与脚本完全一致」)——
 * 注释拦不住漂移,漂移的后果是「装完了,某个角色登不进去」。这里把它变成机械判据。
 *
 * 另外把 lambda 的**离线真跑替身**(python unittest,11 例)接进常规门禁:
 * 那一层只有真部署才会执行,不接进来就会变成「没人跑的一层」(prod-only-layers 的病)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const STACK = resolve(REPO, "infra/lib/auth-stack.ts");
const SCRIPT = resolve(REPO, "scripts/10-bootstrap-cognito.sh");
const LAMBDA = resolve(REPO, "infra/lambda/cognito-bootstrap/index.py");

// 逐行剥注释:跨行正则会吃掉真代码(本仓吃过这个教训)。
function stripComments(src: string, lineComment: string): string {
  return src
    .split("\n")
    .map((l) => {
      const i = l.indexOf(lineComment);
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

function rosterFromStack(): Record<string, string> {
  const src = readFileSync(STACK, "utf8");
  const m = src.match(/const BOOTSTRAP_ROSTER: Record<string, string> = \{([\s\S]*?)\};/);
  if (!m) throw new Error("auth-stack.ts 里找不到 BOOTSTRAP_ROSTER");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^\s*"?([\w-]+)"?\s*:\s*"([^"]*)"/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function rosterFromScript(): Record<string, string> {
  const src = stripComments(readFileSync(SCRIPT, "utf8"), "#");
  const users = src.match(/^USERS=\(([^)]*)\)/m);
  const groups = src.match(/^declare -A GROUP=\(([\s\S]*?)\)\s*$/m);
  if (!users || !groups) throw new Error("脚本里找不到 USERS / GROUP");
  const names = users[1].trim().split(/\s+/).filter(Boolean);
  const map: Record<string, string> = {};
  for (const m of groups[1].matchAll(/\[([\w-]+)\]=("?)([\w-]*)\2/g)) map[m[1]] = m[3];
  const out: Record<string, string> = {};
  for (const n of names) out[n] = map[n] ?? "__缺映射__";
  return out;
}

describe("建初始用户:名册三侧一致 + 路径C 的形状", () => {
  it("名册在 auth-stack 与 10-bootstrap-cognito.sh 里逐字一致(含谁不进组)", () => {
    expect(rosterFromScript()).toEqual(rosterFromStack());
  });

  it("组名集合 = 名册里所有非空组(脚本的 RBAC_GROUPS 不许自己另列一套)", () => {
    const want = [...new Set(Object.values(rosterFromStack()).filter(Boolean))].sort();
    const src = stripComments(readFileSync(SCRIPT, "utf8"), "#");
    const m = src.match(/^RBAC_GROUPS=\(([^)]*)\)/m);
    expect(m, "脚本里找不到 RBAC_GROUPS").toBeTruthy();
    expect(m![1].trim().split(/\s+/).filter(Boolean).sort()).toEqual(want);
  });

  it("🔴 路径C 只把**参数名**交给 CloudFormation:模板侧不许出现任何口令来源", () => {
    const src = stripComments(readFileSync(STACK, "utf8"), "//");
    // 自定义资源属性里只有参数名与名册版本
    expect(src).toMatch(/PasswordsSsmParameter:\s*pwParam/);
    // 不许把口令做成 CfnParameter / 环境变量 / 明文属性(那正是当年否掉 CFN 自定义资源的理由)
    expect(src).not.toMatch(/CfnParameter/);
    expect(src).not.toMatch(/BGP_ADMIN_PASSWORD|Password:\s*['"]/);
  });

  it("🔴 引导函数的 kms:Decrypt 必须按 ViaService 收窄(不许裸 * )", () => {
    const src = stripComments(readFileSync(STACK, "utf8"), "//");
    const kms = src.slice(src.indexOf('actions: ["kms:Decrypt"]'));
    expect(kms).toMatch(/kms:ViaService/);
  });

  it("测试代码不许被打进上线产物(函数目录 = fromAsset 打包源)", () => {
    const py = readFileSync(LAMBDA, "utf8");
    expect(py).toContain("def handler(");
    // 替身放在 infra/test/,不在 infra/lambda/cognito-bootstrap/ 里
    expect(() => readFileSync(resolve(REPO, "infra/lambda/cognito-bootstrap/test_handler.py"), "utf8")).toThrow();
    expect(readFileSync(resolve(REPO, "infra/test/cognito-bootstrap/test_handler.py"), "utf8")).toContain("cfn_event");
  });

  it("🔴 lambda 的离线真跑替身(python unittest)全绿,且**真的跑了** ≥11 例", () => {
    // 🔴 unittest 把结果写 **stderr**;而且「一例都没发现」也是 exit 0 + 「Ran 0 tests」——
    //    只断退出码 = 空转即成功。所以既断退出码,也断例数下限。
    const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", "infra/test/cognito-bootstrap", "-p", "test_*.py"], {
      cwd: REPO,
      encoding: "utf8",
    });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-800)).toBe(0);
    const ran = Number((all.match(/Ran (\d+) tests?/) || [])[1] || 0);
    expect(ran).toBeGreaterThanOrEqual(11);
    expect(all).toMatch(/\bOK\b/);
  });
});
