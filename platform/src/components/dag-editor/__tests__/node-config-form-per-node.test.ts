// 🔴🔴 编排编辑器「节点配置」抽屉:换节点必须换一份表单值仓。
//
// 【缺陷原形(2026-10-24 页面驱动段 slsw SW-12,真 DOM 探针坐实)】两个 Python 节点逐个配置(每次都关抽屉)、保存后重开编辑器,
//   第二个节点的脚本是**空的**;直接点第二个节点时抽屉里显示的是第一个节点的值。
//   根因:`Form.useForm()` 建在**常驻**的 NodeConfigPanel 里(没选中节点时它只是 return null),<Form> 重挂时 rc-field-form 把
//   initialValues **合并**进旧值仓(旧值赢)⇒ 第二个节点看到第一个节点的名称 / 脚本;不改就什么都没存,改一个字就把上一个节点
//   的全部字段整份写进这个节点。
// 【这组判据钉的是接线事实】值仓必须随节点换新:useForm 只许住在按 node.id 加 key 渲染的表单组件里。
//   🔴 行为本身(填了的脚本真的落到了该节点)由页面驱动段 slsw SW-12 在真 DOM 上判;本文件没有 DOM,只守住这条接线不被改回去。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 去掉注释再判(注释里讲缺陷原形时会写到 `Form.useForm()` 这个词,不能让它放行 / 误判)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}
const SRC = stripComments(readFileSync(resolve(__dirname, "../NodeConfigPanel.tsx"), "utf8"));

/** 取一个顶层函数的函数体:从它的声明行起,到下一个顶层 `function` / `export` 声明之前(切块,不开字符窗口)。 */
function topLevelFunctionBody(src: string, declRe: RegExp): string {
  const m = declRe.exec(src);
  if (!m) throw new Error(`没找到声明 ${declRe}`);
  const start = m.index;
  const rest = src.slice(start + m[0].length);
  const next = /\n(?:export\s+)?(?:default\s+)?function\s+[A-Z]/.exec(rest);
  return rest.slice(0, next ? next.index : rest.length);
}

describe("NodeConfigPanel:一个节点一份表单值仓", () => {
  const outer = topLevelFunctionBody(SRC, /export default function NodeConfigPanel\s*\(/);
  // NodeConfigForm 改为具名导出(job-node-render 判据服务端真渲染它);值仓仍只在它里面
  const inner = topLevelFunctionBody(SRC, /\n(?:export )?function NodeConfigForm\s*\(/);

  it("常驻的外层组件里**没有** Form.useForm —— 值仓一旦建在这里就会跨节点存活(缺陷原形)", () => {
    expect(outer).not.toMatch(/Form\.useForm\s*\(/);
    expect(outer).not.toMatch(/<Form\b/);
  });

  it("外层以 key={node.id} 渲染表单组件:换节点 = 换组件实例 = 全新值仓", () => {
    expect(outer).toMatch(/<NodeConfigForm\s+key=\{node\.id\}/);
  });

  it("表单组件自己持有 useForm,且 initialValues 来自**这个**节点的 data", () => {
    expect(inner).toMatch(/Form\.useForm\s*\(/);
    expect(inner).toMatch(/<Form\b[^>]*\bform=\{form\}[^>]*\binitialValues=\{node\.data\}/);
    // 改动回写仍带上该节点原有 data(表单里没有的字段不丢)
    expect(inner).toMatch(/onChange\(node\.id,\s*\{\s*\.\.\.node\.data,\s*\.\.\.values\s*\}\)/);
  });

  it("全文件只有一处 useForm(不许外层再偷偷建一份)", () => {
    expect((SRC.match(/Form\.useForm\s*\(/g) || []).length).toBe(1);
  });
});
