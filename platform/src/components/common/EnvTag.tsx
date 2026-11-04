"use client";

// @kf-batch 50-SEQ47a-promote-ux —— 资源所在环境的标签(dev / staging / prod),颜色与顶栏环境切换器同一作者(ENV_COLOR)。
//   客户 2026-10-19 反馈「界面如何在 dev 一键发布至 prod」—— 页面核实:资源详情里**看不出自己在哪个环境**,顶栏切换器又不起眼。

import React from "react";
import { Tag, Tooltip } from "antd";
import { ENV_COLOR, ENV_DESC } from "@/lib/projects/constants";
import { useT } from "@/lib/i18n/useT";

export default function EnvTag({ env, current = false }: { env: string; current?: boolean }) {
  const t = useT();
  const desc = ENV_DESC[env as keyof typeof ENV_DESC];
  return (
    <Tooltip title={current
      ? t("当前环境:{env}（{desc}）。资源按环境隔离,顶栏可切换环境。", { env, desc: desc ? t(desc) : env })
      : t("资源所在环境:{env}（{desc}）", { env, desc: desc ? t(desc) : env })}>
      <Tag data-testid="env-tag" data-env={env} color={ENV_COLOR[env as keyof typeof ENV_COLOR] || "default"} style={{ marginInlineEnd: 0 }}>
        {env}
      </Tag>
    </Tooltip>
  );
}
