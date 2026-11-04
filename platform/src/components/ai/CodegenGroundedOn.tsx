"use client";
// AI 代码生成「这份代码按哪个区的数据目录生成」的**唯一呈现作者**(作业开发 / EMR 两处共用)。
// 🔴 原来生成恒按主控区的仓/湖目录 + 主控区工作组实名做 grounding,而页面一个字不说 ⇒ 给 us-west-2 的作业
//   生成出一份引用主控区表与工作组的代码,用户只能在运行失败时才发现。服务端回 `groundedOn`,这里如实呈现。
import { Typography } from "antd";
import { useT } from "@/lib/i18n/useT";

export interface CodegenGroundedOnValue { targetId: string; region: string; workgroup: string; database: string }

export function CodegenGroundedOn({ value, boundTargets }: { value?: CodegenGroundedOnValue | null; boundTargets: string[] }) {
  const t = useT();
  if (!value) {
    return <Typography.Text type="danger" data-testid="ai-gen-grounded-on" data-region="">{t("未回报按哪个区的目录生成 —— 请勿直接使用")}</Typography.Text>;
  }
  const others = boundTargets.filter((x) => x !== value.targetId);
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="ai-gen-grounded-on" data-region={value.region} data-target={value.targetId}>
      {t("按 {region}({tid})的数据目录生成 · 数仓工作组 {wg} / 库 {db}", { region: value.region, tid: value.targetId, wg: value.workgroup, db: value.database })}
      {others.length > 0 ? t(";本作业还绑了 {others},那些区的表结构须与之一致", { others: others.join("、") }) : ""}
    </Typography.Text>
  );
}
