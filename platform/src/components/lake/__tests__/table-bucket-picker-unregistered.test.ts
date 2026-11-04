// 向导表桶下拉的「未登记」标与提示(客户 2026-10-27:选了自有桶,到「启动」才 409 且没有下一步)。
//   ① 提示判定是纯函数(清单没拉到不吓人 / 平台表桶与已登记不提示 / 主控区与执行区措辞不同,由清单接口的 home 说);
//   ② 组件接线:同步向导传 writeIntent、系统设置登记入口不传;选项带 data-unregistered;提示带去登记链接且锚到系统设置那张卡的 id;
//   ③ 真渲染:writeIntent 下清单未就位(idle)不出提示,输入框照常(与 form-id 判据同一渲染路径)。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Form } from "antd";
import TableBucketPicker, { unregisteredBucketHint, LAKE_EXT_BUCKETS_ANCHOR } from "@/components/lake/TableBucketPicker";
import I18nProvider from "@/lib/i18n/I18nProvider";
import type { TableBucketCandidates } from "@/lib/lake/table-bucket-candidates";

const h = React.createElement;
const SRC = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");

const usw2: TableBucketCandidates = {
  targetId: "tgt_usw2_a", region: "us-west-2", home: false, platformBucket: "bgp-table-bucket-usw2-a",
  buckets: [
    { name: "bgp-table-bucket-usw2-a", arn: "a", platform: true, registered: false },
    { name: "cust-registered", arn: "b", platform: false, registered: true },
    { name: "cust-unregistered", arn: "c", platform: false, registered: false },
  ],
};
const home: TableBucketCandidates = { ...usw2, targetId: "tgt_home", region: "us-east-1", home: true, platformBucket: "bgp-table-bucket" };

describe("① unregisteredBucketHint(纯函数)", () => {
  it("非写意图 / 没落点 / 没选值 / 清单没拉到 ⇒ 不提示", () => {
    expect(unregisteredBucketHint({ writeIntent: false, targetId: "tgt_usw2_a", value: "cust-unregistered", status: "ok", data: usw2 })).toBeNull();
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "", value: "cust-unregistered", status: "ok", data: usw2 })).toBeNull();
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_usw2_a", value: "  ", status: "ok", data: usw2 })).toBeNull();
    for (const status of ["idle", "loading", "error"] as const) {
      expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_usw2_a", value: "cust-unregistered", status, data: undefined }), status).toBeNull();
    }
  });

  it("平台表桶(按名 / 按标)与已登记 ⇒ 不提示", () => {
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_usw2_a", value: "bgp-table-bucket-usw2-a", status: "ok", data: usw2 })).toBeNull();
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_usw2_a", value: " cust-registered ", status: "ok", data: usw2 })).toBeNull();
    const unlisted = { ...usw2, buckets: usw2.buckets.filter((b) => !b.platform) };
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_usw2_a", value: "bgp-table-bucket-usw2-a", status: "ok", data: unlisted })).toBeNull();
  });

  it("🔴 未登记(清单里的 / 手填不在清单里的)⇒ 提示;执行区与主控区按清单接口的 home 分措辞", () => {
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_usw2_a", value: "cust-unregistered", status: "ok", data: usw2 }))
      .toEqual({ kind: "exec-env", targetId: "tgt_usw2_a", bucket: "cust-unregistered" });
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_usw2_a", value: "typed-by-hand", status: "ok", data: usw2 }))
      .toEqual({ kind: "exec-env", targetId: "tgt_usw2_a", bucket: "typed-by-hand" });
    expect(unregisteredBucketHint({ writeIntent: true, targetId: "tgt_home", value: "cust-unregistered", status: "ok", data: home }))
      .toEqual({ kind: "home", targetId: "tgt_home", bucket: "cust-unregistered" });
  });
});

describe("② 接线", () => {
  it("同步向导的 Table Bucket 传 writeIntent;系统设置的登记入口不传", () => {
    const modal = strip(read("app/sync/SyncTaskModal.tsx"));
    expect(modal).toMatch(/<TableBucketPicker targetId=\{watchDsOwnerTarget\}[^\n]*\bwriteIntent\b[^\n]*data-testid="sync-s3t-bucket-picker"/);
    const settings = strip(read("app/settings/page.tsx"));
    expect(settings).toMatch(/<TableBucketPicker targetId=\{lakeTargetId\}[^\n]*excludePlatform excludeRegistered/);
    expect(settings).not.toMatch(/<TableBucketPicker targetId=\{lakeTargetId\}[^\n]*writeIntent/);
  });

  it("去登记链接锚到系统设置那张卡(Card id 与 LAKE_EXT_BUCKETS_ANCHOR 同值);选项带 data-unregistered;提示带 testid", () => {
    expect(LAKE_EXT_BUCKETS_ANCHOR).toBe("/settings#lake-ext-buckets");
    const settings = strip(read("app/settings/page.tsx"));
    expect(settings).toMatch(/<Card\s+id="lake-ext-buckets"/);
    const picker = strip(read("components/lake/TableBucketPicker.tsx"));
    expect(picker).toContain('data-unregistered={unregistered ? "1" : "0"}');
    expect(picker).toContain('data-testid="table-bucket-unregistered-hint"');
    expect(picker).toMatch(/<a href=\{LAKE_EXT_BUCKETS_ANCHOR\} target="_blank" rel="noreferrer" data-testid="table-bucket-register-link">/);
    expect(picker).toMatch(/hint\.kind === "exec-env"\s*\?\s*t\("表桶 \{b\} 还没有为执行环境 \{tid\} 登记/);
  });

  it("清单接口把 home 一起给(页面不按 targetId 字面猜主控区)", () => {
    const lib = strip(read("lib/lake/table-bucket-candidates.ts"));
    expect(lib).toMatch(/return \{ targetId: place\.targetId, region: place\.region, home: place\.home, platformBucket: place\.bucket, buckets \};/);
    expect(strip(read("components/lake/TableBucketPicker.tsx"))).not.toMatch(/isHome\(|"tgt_home"/);
  });
});

describe("③ 真渲染(服务端):writeIntent 下清单未就位不出提示,Form.Item 的 id 仍落到输入框", () => {
  it("idle ⇒ 没有提示节点;input 带 s3Config_tableBucket", () => {
    const picker = h(TableBucketPicker, { targetId: "", writeIntent: true, value: "cust-unregistered", placeholder: "留空自动解析" });
    const html = renderToStaticMarkup(h(I18nProvider, null, h(Form, null, h(Form.Item, { name: ["s3Config", "tableBucket"], label: "Table Bucket" }, picker))));
    expect(html).not.toContain("table-bucket-unregistered-hint");
    expect(html).toMatch(/<input[^>]*\bid="s3Config_tableBucket"/);
  });
});
