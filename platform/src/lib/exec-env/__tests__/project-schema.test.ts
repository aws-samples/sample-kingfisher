// G4(提前并入 G2R)—— 项目 schema / role 命名 SSOT 单测(52 SPEC §3.0)。
//
// 【为什么必须钉住】现状有**三套互不兼容**的 sanitize(s3tables / modeling.safeIdent / glue python)。
// 三套并存 ⇒ 建表用一套、查询用另一套 ⇒ "建好的表查不到"。本文件把权威口径钉死。
import { describe, it, expect } from "vitest";
import { SHARED_SCHEMA, projectSchema, projectRoleName, projectLakeNamespace, assertProjectId, isSchemaOfProject, projectSecretName, projectDbUserName } from "@/lib/exec-env/project-schema";
import { ulid } from "ulid";

// 🔴 **fixture 必须像真的**:原来这里是 `"0".repeat(26)` —— 全数字、**大小写同形**,
//    恰好绕过了唯一有区别的那一维,于是"校验只收小写而平台只生成大写"这个 bug
//    在 1600+ 单测里一路全绿,直到 D4 成为 projectSchema() 的第一个生产调用方才在真环境炸
//    (症状:所有项目都删不掉)。现在用**真环境抓下来的形态**当 fixture。
const ULID = "01M1KP594D2E6DJQC8EZ8CRAES"; // 真环境实测形态(大写 Crockford base32,含字母)
const PID = `proj-${ULID}`;
// schema/role 名一律小写(sanitize 全局小写化)⇒ 断言用小写形态。
const ULID_LC = ULID.toLowerCase();

describe("assertProjectId —— 只接受平台生成形态", () => {
  it("接受**真实**大写 ULID 形态与 legacy 常量", () => {
    expect(assertProjectId(PID)).toBe(PID);
    expect(assertProjectId("proj-default")).toBe("proj-default");
    // 全数字那种(旧 fixture)当然也还合法 —— 但它证明不了大小写这一维。
    expect(assertProjectId(`proj-${"0".repeat(26)}`)).toBe(`proj-${"0".repeat(26)}`);
  });

  it("🔴 回归钉:`ulid()` 产出的是**大写**,校验必须收(2026-09-03 真环境 bug)", () => {
    // 与 project-service.createProject 用的同一个包,直接现场生成,不靠我记忆里的形态。
    const real = `proj-${ulid()}`;
    expect(() => assertProjectId(real), `平台真实生成的 ${real} 被拒 = 所有项目都删不掉`).not.toThrow();
    expect(projectSchema(real)).toMatch(/^proj_proj_[0-9a-z]{26}$/);
  });

  it("🔴 拒**小写化**的同一个 id —— 否则 sanitize 后两个 id 撞同一 schema = 跨项目数据混淆", () => {
    expect(() => assertProjectId(PID.toLowerCase())).toThrow();
  });

  it("🔴 拒任意字符串 —— 否则 sanitize 后两个不同 projectId 可能撞到同一 schema = 跨项目数据混淆", () => {
    for (const bad of [
      "", "abc", "proj_x",
      "proj-" + "0".repeat(25),      // 长度不足
      "proj-" + "L".repeat(26),      // Crockford 排除 I/L/O/U
      "proj-" + "I".repeat(26),
      "proj-" + "O".repeat(26),
      "proj-" + "U".repeat(26),
      "proj-" + "l".repeat(26),      // 小写同理
      null, 1, {},
    ]) {
      expect(() => assertProjectId(bad as never), `应拒 ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe("projectSchema —— 逐字按 52 SPEC §3.0", () => {
  it("🔴 一般形态产物带重复前缀 `proj_proj_<ulid>` —— 这是合同原文,不是 bug", () => {
    // 合同是 `proj_<sanitize(projectId)>`,而 projectId 形如 `proj-<ulid>`。
    // 合同还专门为 proj-default 写了"不是 proj_proj_default"的特例,说明作者知道会重复。
    // 我不在实现里偷偷改掉它:那是改 52 SPEC §3.0 的合同变更,须单独立批。
    expect(projectSchema(PID)).toBe(`proj_proj_${ULID_LC}`);
  });

  it("`proj-default` 特例 → `proj_default`(不是 proj_proj_default)", () => {
    expect(projectSchema("proj-default")).toBe("proj_default");
  });

  it("产物永远在 Redshift 标识符上限 127 内", () => {
    expect(projectSchema(PID).length).toBeLessThanOrEqual(127);
    expect(projectSchema("proj-default").length).toBeLessThanOrEqual(127);
  });

  it("同一 projectId 稳定幂等(建表与查询必须拿到同一个名字)", () => {
    expect(projectSchema(PID)).toBe(projectSchema(PID));
  });

  it("数据湖 namespace 与 schema 同源(共用同一 sanitize)", () => {
    expect(projectLakeNamespace(PID)).toBe(projectSchema(PID));
  });
});

describe("projectRoleName", () => {
  it("形如 role_proj_<sanitize(id)>", () => {
    expect(projectRoleName(PID)).toBe(`role_proj_proj_${ULID_LC}`);
  });

  it("proj-default 不产生双前缀", () => {
    expect(projectRoleName("proj-default")).toBe("role_proj_default");
  });

  it("长度不超上限", () => {
    expect(projectRoleName(PID).length).toBeLessThanOrEqual(127);
  });
});

describe("🔴 per-project 凭证的派生名(供给层要用)", () => {
  const PID = "proj-01M1KP594D2E6DJQC8EZ8CRAES";

  it("secret 名形态 = bgp/project/<targetSlug>/<原样 projectId>", () => {
    expect(projectSecretName("tgt_home", PID)).toBe(`bgp/project/tgt-home/${PID}`);
    expect(projectSecretName("tgt_usw2_a", PID)).toBe(`bgp/project/tgt-usw2-a/${PID}`);
  });

  it("🔴 前缀必须落在 IAM 允许的自管命名空间里(否则建 secret 必 AccessDenied)", () => {
    // infra 的 secret **写**语句只允许 `bgp/*` 与 `bgp-*` 两个前缀 —— 名字一旦不带 `bgp/`,
    // 供给层会在真环境拿到 AccessDenied,而单测什么都看不出来。
    expect(projectSecretName("tgt_home", PID).startsWith("bgp/")).toBe(true);
  });

  it("🔴 target 维与项目维都参与:换 target 或换项目都必须换名(不能撞)", () => {
    const OTHER = "proj-01M1KP594D2E6DJQC8EZ8CRAEZ";
    expect(projectSecretName("tgt_home", PID)).not.toBe(projectSecretName("tgt_usw2_a", PID));
    expect(projectSecretName("tgt_home", PID)).not.toBe(projectSecretName("tgt_home", OTHER));
  });

  it("Secrets Manager 名字字符集与长度都合法", () => {
    const n = projectSecretName("tgt_" + "a".repeat(16), PID);
    expect(n.length).toBeLessThanOrEqual(512);
    // 允许 alnum 与 /_+=.@-
    expect(n).toMatch(/^[A-Za-z0-9/_+=.@-]+$/);
  });

  it("非法 projectId / targetId 一律抛(不许拼出垃圾 secret 名)", () => {
    expect(() => projectSecretName("tgt_home", "proj-abc")).toThrow();
    expect(() => projectSecretName("tgt_home", PID.toLowerCase())).toThrow(); // 小写形态不接受
    expect(() => projectSecretName("TGT_HOME", PID)).toThrow();
    expect(() => projectSecretName("tgt_home", "")).toThrow();
  });

  it("DB 用户名与 role 名同 sanitize、可肉眼对应,且不相等", () => {
    expect(projectDbUserName(PID)).toBe(`user_${projectSchema(PID)}`);
    expect(projectDbUserName(PID)).not.toBe(projectRoleName(PID));
    expect(projectDbUserName("proj-default")).toBe("user_proj_default");
    expect(projectDbUserName(PID).length).toBeLessThanOrEqual(127);
  });
});

describe("isSchemaOfProject —— 归属判定(守卫用它挡跨项目)", () => {
  it("本项目 schema 为真", () => {
    expect(isSchemaOfProject(projectSchema(PID), PID)).toBe(true);
    expect(isSchemaOfProject(projectSchema(PID).toUpperCase(), PID)).toBe(true); // 大小写不敏感
  });

  it("🔴 别的项目 / shared / 任意名一律为假", () => {
    expect(isSchemaOfProject("proj_b", PID)).toBe(false);
    expect(isSchemaOfProject(SHARED_SCHEMA, PID)).toBe(false);
    expect(isSchemaOfProject("public", PID)).toBe(false);
  });
});
