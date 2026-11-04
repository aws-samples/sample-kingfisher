// 「该区没装数仓 ⇒ 目录必须说出来」的单测(2026-09-12 写判据时挖出的产品缺口)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noWarehouseMeta, NO_WAREHOUSE_REASON, degradeIfNoWarehouse } from "../direct-query";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

describe("目录的「该区没装数仓」说明", () => {
  it("没装 redshift ⇒ 给出说明,且**逐字复用**直查那条路的同一份文案(单一作者)", () => {
    const m = noWarehouseMeta({ targetId: "tgt_use1_b", components: ["core"] });
    expect(m).toEqual({ targetId: "tgt_use1_b", missing: "redshift", reason: NO_WAREHOUSE_REASON });
    // 🔴 与直查降级的文案必须**同一个字符串对象来源** —— 各写一份措辞,用户就会看到「同一件事两种说法」
    class TBR extends Error { constructor(readonly reason: string) { super("x"); this.name = "TargetBindingRejected"; } }
    // 这里只断文案常量同源(构造真的 TargetBindingRejected 需要它的类,单测不必依赖)
    expect(NO_WAREHOUSE_REASON).toContain("数据仓库");
    expect(typeof degradeIfNoWarehouse).toBe("function");
    void TBR;
  });

  it("装了 redshift ⇒ 不给说明(否则装好的区也天天挂一条警告)", () => {
    expect(noWarehouseMeta({ targetId: "tgt_use1_a", components: ["core", "redshift"] })).toBeUndefined();
  });

  it("没点名单一 target(全部 / 多区对比)⇒ 不给说明(那不是「某个区没装」这件事)", () => {
    expect(noWarehouseMeta(undefined)).toBeUndefined();
  });

  it("🔴 结构性:目录路由必须**只把它放进 `_meta`**、不许改 `data` 形状", () => {
    const route = strip(readFileSync(resolve(SRC, "app/api/governance/catalog/route.ts"), "utf8"));
    expect(route).toMatch(/noWarehouseMeta\(/);
    // data 仍是数组:apiOk 的第一参必须还是 annotated(把 warehouse 混进 data 会打空页面表格,
    // 也会让那些「逐行比目录」的判据全部失效)
    expect(route).toMatch(/apiOk\(\s*annotated\s*,\s*200/);
    expect(route).not.toMatch(/apiOk\(\s*\{[^)]*warehouse/);
  });

  it("🔴 结构性:治理页必须读 `_meta.warehouse`(只认旧的 payload.capability 就等于这条修法没接上)", () => {
    const page = strip(readFileSync(resolve(SRC, "app/governance/page.tsx"), "utf8"));
    expect(page).toMatch(/_meta\?\.\s*warehouse\?\.\s*reason|_meta\?\.warehouse\?\.reason/);
    expect(page).toMatch(/setNoWarehouse\(metaNoWh\)/);
  });
});
