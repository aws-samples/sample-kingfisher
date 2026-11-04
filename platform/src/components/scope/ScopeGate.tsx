"use client";
// 按路由能力渲染四种壳 + 两种错误壳(合同 SPEC v3.36 §2.6.7;判据)。
//
// 🔴 四种壳(正常路径):
//   ① `global-only`            ⇒ 说明条 + 内容,**选择器不重置**
//   ② `target-only` 且 global 且可见 target ≥2 ⇒ 「请选择执行范围」,**内容一个字都不渲染**
//   ③ `wired:false`            ⇒ 内容 + **常驻**提示条,🔴 且提示条要说出**差什么**
//   ④ 其余                      ⇒ 正常内容
// 🔴 两种错误壳:URL 里的 scope **文法非法** / **指向不可用的执行环境** ⇒ 报错 + 一个**显式**
//   〔切到「全部」〕按钮。绝不自动改写 URL —— 前端吃掉 4xx 再偷偷切 global 是最隐蔽的回落。

import React from "react";
import { usePathname } from "next/navigation";
import { Alert, Button, Empty, Space } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
// 横幅不再是两句放之四海皆准的断言:全局页渲染**登记过的理由**,
// 未接入页渲染**差什么 + 现在看到的是全部区域**。
import { capabilityForPath, GLOBAL_REASONS, isGlobalOnly, isNotWired, partialOf } from "@/lib/scope/capability";
import { routeLabelOf } from "@/components/layout/routes";
import { useScope } from "./ScopeProvider";

function SwitchToGlobal({ label }: { label: string }) {
  const { setScope } = useScope();
  return (
    <Button size="small" icon={<GlobalOutlined />} data-testid="scope-switch-global" onClick={() => setScope({ kind: "global" })}>
      {label}
    </Button>
  );
}

export default function ScopeGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const pathname = usePathname();
  const cap = capabilityForPath(pathname);
  const { scope, decision, targets, effectiveScope } = useScope();

  if (!cap) return <>{children}</>;

  // ── 错误壳:URL 里的值有问题 ────────────────────────────────────────────────
  if (decision.kind === "url-invalid") {
    return (
      <Empty
        data-testid="scope-error-invalid"
        description={
          <Space direction="vertical" size={4}>
            <span>{t("地址里的执行范围取值非法:")}<code>{decision.raw}</code></span>
            <span style={{ color: "#90a4c0", fontSize: 12 }}>
              {t("合法形态:global / 一个执行环境 / cmp:两到四个执行环境（英文逗号分隔）")}
            </span>
            <SwitchToGlobal label={t("切到「全部」")} />
          </Space>
        }
      />
    );
  }
  if (decision.kind === "url-unavailable") {
    return (
      <Empty
        data-testid="scope-error-unavailable"
        description={
          <Space direction="vertical" size={4}>
            <span>
              {t("地址里指定的执行范围当前不可用:")}<code>{decision.missing.join(", ")}</code>
            </span>
            <span style={{ color: "#90a4c0", fontSize: 12 }}>
              {t("可能已删除、尚未初始化完成、正在下线,或本项目未获授权。这里不会自动切到别的区域。")}
            </span>
            <SwitchToGlobal label={t("切到「全部」")} />
          </Space>
        }
      />
    );
  }

  // ── compare:护栏 6 —— 只有声明支持的页才做对比态 ────────────────────────────
  if (scope.kind === "compare" && !cap.scopeCompare) {
    return (
      <Empty
        data-testid="scope-error-no-compare"
        description={
          <Space direction="vertical" size={4}>
            <span>{t("本页不支持「对比」范围（对比只用于成本与一致性矩阵）")}</span>
            <SwitchToGlobal label={t("切到「全部」")} />
          </Space>
        }
      />
    );
  }

  // ── ① global-only:**自证**(理由码 + 按区的东西去哪看);**不重置选择器** ────────────
  // 🔴 2026-09-10 用户点名否掉了原来那句「此页属于全局控制平面,不受当前执行范围影响」——
  // 一句断言等于零成本豁免。现在必须把**为什么**说出来,并给出**按区的东西去哪看**;
  // 编不出理由码的页面就不该声明全局(那 7 页已如实翻进 `wired:false` 名单)。
  if (isGlobalOnly(cap)) {
    const self = cap.insteadSee === "self";
    return (
      <>
        <Alert
          data-testid="scope-banner-global-only"
          type="info"
          showIcon
          banner
          style={{ marginBottom: 12 }}
          message={
            <span data-testid="scope-global-reason">
              {t(GLOBAL_REASONS[cap.globalReason])}
              {self ? null : (
                <>
                  {t("。想按区域看数据,请到")}
                  <a href={cap.insteadSee} data-testid="scope-instead-see" style={{ marginLeft: 4 }}>
                    {routeLabelOf(cap.insteadSee)}
                  </a>
                </>
              )}
            </span>
          }
        />
        {children}
      </>
    );
  }

  // ── ② target-only 且当前是「全部」───────────────────────────────────────────
  if (cap.scope === "target-only") {
    const eff = effectiveScope(cap);
    if (eff.kind === "global") {
      // 🔴 内容一个字都不渲染:断的是「DOM 里没有任何 home 数据行」
      return (
        <Empty
          data-testid="scope-need-target"
          description={
            <Space direction="vertical" size={4}>
              <span>{t("请选择执行范围")}</span>
              <span style={{ color: "#90a4c0", fontSize: 12 }}>
                {t("本页必须锚定一个执行环境后才能使用（顶栏「执行范围」里选一个）")}
                {targets ? `,${t("当前可选")} ${targets.length} ${t("个")}` : ""}
              </span>
            </Space>
          }
        />
      );
    }
  }

  // ── ③ 未接入:内容 + **常驻**提示条(说出差什么)─────────────────────────
  // 🔴 用户 2026-09-10 逐字点名这句横幅「有问题」。问题不在于它出现,而在于它**什么都没说**:
  // 九个页面同一句话,用户既不知道差什么、也不知道谁在管、更不知道该去哪看按区数据。
  if (isNotWired(cap)) {
    return (
      <>
        <Alert
          data-testid="scope-banner-not-wired"
          type="warning"
          showIcon
          banner
          style={{ marginBottom: 12 }}
          message={
            <span>
              {t("本页的数据还没有按执行范围过滤,你现在看到的是")}
              <b>{t("全部区域")}</b>
              {t("的数据。")}
            </span>
          }
          description={<span data-testid="scope-not-wired-missing">{t(cap.missing)}</span>}
        />
        {children}
      </>
    );
  }

  // ── ④ 已接入但**部分**:常驻一条说明条,点名哪几块不分区────────────
  // 🔴 为什么不做成「不显示」:用户切到某个区,看到页面上还有几块是全平台数字 —— 不说清楚,
  // 他要么以为那几块也是这个区的(被误导),要么以为整页都没过滤(不信任已经做好的部分)。
  const partial = partialOf(cap);
  if (partial) {
    return (
      <>
        <Alert
          data-testid="scope-banner-partial"
          type="info"
          showIcon
          banner
          style={{ marginBottom: 12 }}
          message={
            <span data-testid="scope-partial-note">
              {t(partial.note)}
            </span>
          }
        />
        {children}
      </>
    );
  }

  // ── ⑤ 正常 ────────────────────────────────────────────────────────────────
  return <>{children}</>;
}
