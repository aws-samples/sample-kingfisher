// @kf-batch 41-B115-netadvisor-place
// 网络顾问面板:落点由消费方给(对象绑定的执行环境)—— 没有就不许分析、多个就让用户选(**不默认主控区**)。
// 判据钉真渲染出来的 DOM(服务端渲染;与 B-93 TableBucketPicker 判据同法),不钉写法。只用真 I18nProvider,不 mock 兄弟模块。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NetworkAdvisorPanel from "@/components/network-advisor/NetworkAdvisorPanel";
import I18nProvider from "@/lib/i18n/I18nProvider";

const h = React.createElement;
const render = (targetIds: string[]) =>
  renderToStaticMarkup(h(I18nProvider, null, h(NetworkAdvisorPanel, { request: { computeKind: "glue", targets: [] }, targetIds })));

describe("NetworkAdvisorPanel 的落点(B-115)", () => {
  it("🔴 没有候选落点 ⇒ 「智能分析网络」禁用 + 提示先选执行环境(不默认主控区)", () => {
    const html = render([]);
    expect(html).toContain('data-testid="netadvisor-need-target"');
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>[\s\S]*?智能分析网络/);
    expect(html).not.toContain('data-testid="netadvisor-target"');
  });
  it("恰好一个 ⇒ 直接用它:显示落点标签、按钮可用、无提示", () => {
    const html = render(["tgt_usw2_a"]);
    expect(html).toMatch(/data-testid="netadvisor-target"[\s\S]*?tgt_usw2_a/);
    expect(html).not.toContain('data-testid="netadvisor-need-target"');
    expect(html).not.toMatch(/<button[^>]*\bdisabled\b[^>]*>[\s\S]*?智能分析网络/);
  });
  it("多个 ⇒ 渲染选择器让用户选,选之前按钮禁用(不许悄悄取第一个)", () => {
    const html = render(["tgt_home", "tgt_usw2_a"]);
    expect(html).toContain("ant-select");
    expect(html).toContain('data-testid="netadvisor-need-target"');
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>[\s\S]*?智能分析网络/);
  });
});
