// 「一个 OpenMetadata、按 service 分区」的判定门禁(合同 50 SPEC §3.4.6)。
//
// 🔴 这几条错了都不会报错,只会让目录**悄悄少半边或多半边**:
//   · home 的 service 若被判成「未知」⇒ 主控区视角凭空少掉 `bgp-sources` / `bgp-s3tables` 那些平台级资产;
//   · 后缀判反 ⇒ us-west-2 视角显示主控区的表(正是用户要消灭的「串味」);
//   · home 的 service 名一旦加后缀 ⇒ 存量 OM 资产全体搬家(FQN 变、血缘断、标签丢)。

import { describe, it, expect } from "vitest";
import { omServiceFor, omServiceTargetOf, omServiceInScope, omServiceBase, OM_SERVICE_PREFIX } from "../om-service";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";

const KNOWN = [HOME_TARGET_ID, "tgt_usw2_a", "tgt_euw1_b"];

describe("o4-REG:五类 service 同一条 per-target 规则 + 基名单一作者", () => {
  it("同步推送的三类(源 / 湖 / 物理端点)与镜像两类同规则:home 无后缀,其它区 -<slug>", () => {
    expect(omServiceFor("sources", HOME_TARGET_ID)).toBe("bgp-sources");
    expect(omServiceFor("s3tables", HOME_TARGET_ID)).toBe("bgp-s3tables");
    expect(omServiceFor("physical", HOME_TARGET_ID)).toBe("bgp-physical");
    expect(omServiceFor("sources", "tgt_usw2_a")).toBe("bgp-sources-tgt-usw2-a");
    expect(omServiceFor("s3tables", "tgt_usw2_a")).toBe("bgp-s3tables-tgt-usw2-a");
    expect(omServiceFor("physical", "tgt_usw2_a")).toBe("bgp-physical-tgt-usw2-a");
  });

  it("per-target service 在视角过滤里归它自己的区(usw2 视角看得见同步推进来的源 / 湖)", () => {
    expect(omServiceInScope("bgp-s3tables-tgt-usw2-a", "tgt_usw2_a", KNOWN)).toBe(true);
    expect(omServiceInScope("bgp-sources-tgt-usw2-a", "tgt_usw2_a", KNOWN)).toBe(true);
    expect(omServiceInScope("bgp-s3tables-tgt-usw2-a", HOME_TARGET_ID, KNOWN)).toBe(false);
  });

  it("omServiceBase:认五类基名 + tgt 后缀;认不出的原样返回(不许把 bgp-redshift-foo 判成 bgp-redshift)", () => {
    for (const [k, base] of Object.entries(OM_SERVICE_PREFIX)) {
      expect(omServiceBase(base), k).toBe(base);
      expect(omServiceBase(`${base}-tgt-usw2-a`), k).toBe(base);
    }
    expect(omServiceBase("bgp-redshift-foo")).toBe("bgp-redshift-foo");
    expect(omServiceBase("bgp-streams")).toBe("bgp-streams");
    expect(omServiceBase("bgp-s3")).toBe("bgp-s3");
    expect(omServiceBase("")).toBe("");
  });

  it("数据源落点的唯一读法:有章读章,存量无章 = 主控区", () => {
    expect(datasourceOwnerTarget({ ownerTargetId: "tgt_usw2_a" })).toBe("tgt_usw2_a");
    expect(datasourceOwnerTarget({})).toBe(HOME_TARGET_ID);
    expect(datasourceOwnerTarget({ ownerTargetId: "" })).toBe(HOME_TARGET_ID);
    expect(datasourceOwnerTarget(null)).toBe(HOME_TARGET_ID);
    // 🔴 章非法 ⇒ 抛(不许让坏章流到下游再变成「查不到 = 主控区」)
    expect(() => datasourceOwnerTarget({ ownerTargetId: "Bad-Id" })).toThrow();
  });
});

describe("service 命名", () => {
  it("🔴 home **不带后缀**(存量 OM 资产零迁移)", () => {
    expect(omServiceFor("redshift", HOME_TARGET_ID)).toBe("bgp-redshift");
    expect(omServiceFor("glue", HOME_TARGET_ID)).toBe("bgp-glue");
  });

  it("非 home 带 `-<targetSlug>` 后缀(slug 来自命名 SSOT,不是这里新造的 id)", () => {
    expect(omServiceFor("redshift", "tgt_usw2_a")).toBe("bgp-redshift-tgt-usw2-a");
    expect(omServiceFor("glue", "tgt_usw2_a")).toBe("bgp-glue-tgt-usw2-a");
  });

  it("前缀常量与 om-push 里的既有 service 名一致(不许再起第二套)", () => {
    expect(OM_SERVICE_PREFIX.redshift).toBe("bgp-redshift");
    expect(OM_SERVICE_PREFIX.glue).toBe("bgp-glue");
  });
});

describe("service → 归属哪个执行环境", () => {
  it("带后缀的归那个 target", () => {
    expect(omServiceTargetOf("bgp-redshift-tgt-usw2-a", KNOWN)).toBe("tgt_usw2_a");
    expect(omServiceTargetOf("bgp-glue-tgt-euw1-b", KNOWN)).toBe("tgt_euw1_b");
  });

  it("🔴 无后缀的一律归 home —— 含 `bgp-sources` / `bgp-s3tables` / `bgp-physical` 这些**平台级**服务", () => {
    for (const s of ["bgp-redshift", "bgp-glue", "bgp-sources", "bgp-s3tables", "bgp-physical", "bgp-streams"]) {
      expect(omServiceTargetOf(s, KNOWN), s).toBe(HOME_TARGET_ID);
    }
  });

  it("🔴 不认识的 target 后缀也归 home(而不是判成那个 target)—— 判据只信**已装好的清单**", () => {
    // `tgt_zzz9` 不在 KNOWN 里 ⇒ 它的 service 归 home:宁可在主控区多显示一行(可见、可查),
    // 也不要凭空造出一个用户在下拉里点不到的区(那是「给一个到不了的数字」同款病,见 N-10)。
    expect(omServiceTargetOf("bgp-redshift-tgt-zzz9", KNOWN)).toBe(HOME_TARGET_ID);
  });

  it("空清单时全部归 home(全新环境只有主控区)", () => {
    expect(omServiceTargetOf("bgp-redshift-tgt-usw2-a", [])).toBe(HOME_TARGET_ID);
  });
});

describe("视角过滤", () => {
  it("「全部」视角不过滤(null ⇒ 全要,与改动前逐字节一致)", () => {
    for (const s of ["bgp-redshift", "bgp-redshift-tgt-usw2-a", "bgp-sources"]) {
      expect(omServiceInScope(s, null, KNOWN), s).toBe(true);
    }
  });

  it("🔴 usw2 视角只留它自己的(主控区那几个一个都不许进来)", () => {
    expect(omServiceInScope("bgp-redshift-tgt-usw2-a", "tgt_usw2_a", KNOWN)).toBe(true);
    expect(omServiceInScope("bgp-glue-tgt-usw2-a", "tgt_usw2_a", KNOWN)).toBe(true);
    expect(omServiceInScope("bgp-redshift", "tgt_usw2_a", KNOWN)).toBe(false);
    expect(omServiceInScope("bgp-sources", "tgt_usw2_a", KNOWN)).toBe(false);
  });

  it("🔴 主控区视角要含平台级服务,但**不含**别的区的", () => {
    expect(omServiceInScope("bgp-redshift", HOME_TARGET_ID, KNOWN)).toBe(true);
    expect(omServiceInScope("bgp-sources", HOME_TARGET_ID, KNOWN)).toBe(true);
    expect(omServiceInScope("bgp-redshift-tgt-usw2-a", HOME_TARGET_ID, KNOWN)).toBe(false);
  });
});
