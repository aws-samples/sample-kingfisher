//该缺陷回归—— TableBucketPicker 放进 Form.Item 后,
// Form.Item 经 cloneElement 注入的字段 id 必须落到输入框上。
// 首版只透传 value / onChange,漏了 id ⇒ 同步向导里 `#s3Config_tableBucket` 消失:
//   标签「Table Bucket」点了不聚焦、校验提示的 aria 关联断了,依赖它的无头判据(o4 s38)整条读不到。
// 判据钉事实(真渲染出来的 DOM:input 的 id、label 的 for),不钉写法。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "antd";
import TableBucketPicker from "@/components/lake/TableBucketPicker";
import I18nProvider from "@/lib/i18n/I18nProvider";

const h = React.createElement;

// 真的 I18nProvider(不 mock 兄弟模块):它读 localStorage / 拉 /api/public/locale 都在 effect 里,服务端渲染不会执行
function render(withItem: boolean): string {
  const picker = h(TableBucketPicker, { targetId: "", placeholder: "留空自动解析" });
  const body = withItem ? h(Form.Item, { name: ["s3Config", "tableBucket"], label: "Table Bucket" }, picker) : picker;
  return renderToStaticMarkup(h(I18nProvider, null, h(Form, null, body)));
}

describe("TableBucketPicker 在 Form.Item 里", () => {
  it("输入框带 Form.Item 注入的 id = s3Config_tableBucket,标签 for 指向它", () => {
    const html = render(true);
    expect(html).toMatch(/<input[^>]*\bid="s3Config_tableBucket"/);
    expect(html).toMatch(/<label[^>]*\bfor="s3Config_tableBucket"/);
  });
  it("负向对照:不在 Form.Item 里就没有这个 id(上一条不是凭空成立)", () => {
    expect(render(false)).not.toContain('id="s3Config_tableBucket"');
  });
});
