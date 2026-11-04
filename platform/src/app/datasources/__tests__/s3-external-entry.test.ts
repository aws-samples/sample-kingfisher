// (用户 2026-10-25 拍板「做」)—— 数据源页 S3 源行「建外部表(Athena 直查)」页面入口
//   ① 成功块服务端真渲染(与判据同法:renderToStaticMarkup + 真 I18nProvider,不 mock 兄弟模块):表名 / 落点区 /
//      「去数据湖直查」链接 = /athena?scope=<表真落的区>&sql=<示例查询>;
//   ② 接缝(源码调用点):数据源页只给 S3 源渲染入口按钮、按行上的章(datasourceOwnerTarget)算落点、真渲染弹窗;
//      弹窗 POST 的是 …/s3-external 且带 dataset;直查页读 ?sql= 预填且不盖用户已写内容。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import I18nProvider from "@/lib/i18n/I18nProvider";
import { S3ExternalTableDone, athenaLinkFor } from "@/app/datasources/S3ExternalTableModal";

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (rel: string) => strip(readFileSync(resolve(HERE, rel), "utf8"));

const RESULT = {
  database: "bgp_s3_ext",
  table: "players",
  qualifiedName: "bgp_s3_ext.players",
  location: "s3://bgp-datalake-x-usw2/gamedata/players/",
  format: "csv",
  columns: [{ name: "player_id" }, { name: "country" }, { name: "score" }],
  ddl: "CREATE EXTERNAL TABLE IF NOT EXISTS bgp_s3_ext.players (…)",
  sampleQuery: "SELECT * FROM bgp_s3_ext.players LIMIT 100",
  targetId: "tgt_usw2_a",
  region: "us-west-2",
};

describe("S3 外表页面入口", () => {
  it("「去数据湖直查」链接锚到表真落的区(?scope=targetId)并预填示例查询(?sql=)", () => {
    expect(athenaLinkFor(RESULT)).toBe("/athena?scope=tgt_usw2_a&sql=SELECT%20*%20FROM%20bgp_s3_ext.players%20LIMIT%20100");
  });

  it("成功块真渲染:显示 bgp_s3_ext.<表>、落点区、列数,「去数据湖直查」是带 scope + sql 的链接", () => {
    const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(S3ExternalTableDone, { result: RESULT, region: "us-west-2" })));
    expect(html).toMatch(/data-testid="ds-s3ext-table"[^>]*>bgp_s3_ext\.players</);
    expect(html).toContain("us-west-2");
    expect(html).toContain("3 列");
    expect(html).toMatch(/<a[^>]*href="\/athena\?scope=tgt_usw2_a&amp;sql=SELECT%20\*%20FROM%20bgp_s3_ext\.players%20LIMIT%20100"[^>]*>/);
    expect(html).toContain('data-testid="ds-s3ext-go-athena"');
    expect(html).toContain("去数据湖直查");
  });

  it("接缝:数据源页只给 S3 源渲染「建外部表」按钮、按行上的章算落点、真渲染弹窗", () => {
    const page = read("../page.tsx");
    expect(page).toMatch(/import S3ExternalTableModal from "\.\/S3ExternalTableModal";/);
    expect(page).toMatch(/import \{ datasourceOwnerTarget \} from "@\/lib\/datasource\/placement-shared";/);
    expect(page).toMatch(/\{record\.type === "s3" && \([\s\S]*?data-testid="ds-s3-external-btn"[\s\S]*?onClick=\{\(\) => openS3External\(record\)\}/);
    expect(page).toMatch(/const targetId = datasourceOwnerTarget\(ds as unknown as Record<string, unknown>\);/);
    expect(page).toMatch(/<S3ExternalTableModal open=\{s3Ext\.open\} ds=\{s3Ext\.ds\} targetId=\{s3Ext\.targetId\} region=\{s3Ext\.region\}/);
    // 不许悄悄把别的类型也放进来(入口只对 S3 范式有意义)
    expect(page.match(/ds-s3-external-btn/g)?.length).toBe(1);
  });

  it("接缝:弹窗 POST …/[id]/s3-external 且带 dataset;直查页读 ?sql= 且不盖用户已写内容", () => {
    const modal = read("../S3ExternalTableModal.tsx");
    expect(modal).toMatch(/fetch\(`\/api\/datasources\/\$\{encodeURIComponent\(ds\.datasourceId\)\}\/s3-external`, \{\s*method: "POST"/);
    expect(modal).toMatch(/body: JSON\.stringify\(\{ dataset \}\)/);
    expect(modal).toMatch(/fetchSourceTables\(ds\.datasourceId, undefined\)/);
    const athena = read("../../athena/page.tsx");
    expect(athena).toMatch(/const preset = new URLSearchParams\(window\.location\.search\)\.get\("sql"\);\s*if \(preset\) setSql\(\(cur\) => cur \|\| preset\);/);
  });
});
