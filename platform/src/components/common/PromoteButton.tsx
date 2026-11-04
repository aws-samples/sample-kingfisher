"use client";

// 模块 15 —「发布到环境」按钮:把当前资源从当前环境发布(晋升)到目标环境。发布到 prod 会创建审批(pending),
// 由项目 owner 在「项目空间」页批准后生效;dev → staging 直接执行。
//
// @kf-batch 50-SEQ47a-promote-ux(客户 2026-10-19 反馈,B-102):功能一直在,但入口叫「晋升」、与「发布到 MWAA 调度」并排,
//   用户按「发布」找不到;发布 / 批准之后页面**没有任何反馈**告诉人「prod 里已经有一份,去哪看」(用户连点 4 次晋升 + 批准)。
//   改法:① 文案「发布到环境」+ 菜单写明顺序与是否需审批;② 成功后给「切到 {toEnv} 环境查看」的动作(切环境 + 跳到该类资源页);
//   ③ 待审批时给「去项目空间审批」;④ 广播 `bgp:promoted` 让详情页的各环境发布状态即时刷新。

import React from "react";
import { Dropdown, Button, message, Modal, notification } from "antd";
import { DeploymentUnitOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { getActiveEnv, setActiveEnv } from "@/lib/projects/active";
import { ENVS, isProtectedEnv } from "@/lib/projects/constants";
import { resourcePath } from "@/lib/env/resource-path";
import type { ResourceType } from "@/lib/versions/version-service";
import { useT } from "@/lib/i18n/useT";

export const PROMOTED_EVENT = "bgp:promoted";

/** 切到目标环境并打开该类资源的页面(环境存在 localStorage,整页跳转后列表就是目标环境的)。 */
export function gotoEnvResource(toEnv: string, type: ResourceType, targetId: string) {
  setActiveEnv(toEnv);
  window.location.assign(resourcePath(type, targetId));
}

export default function PromoteButton({
  type,
  id,
  onPromoted,
}: {
  type: ResourceType;
  id: string;
  onPromoted?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const cur = getActiveEnv();
  const targets = (ENVS as readonly string[]).filter((e) => e !== cur);

  const promote = async (toEnv: string) => {
    const res = await fetch("/api/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id, toEnv }),
    });
    const d = await res.json();
    if (!d?.success) {
      message.error(d?.error?.message || t("发布失败"));
      return;
    }
    if (d.data?.pending) {
      Modal.confirm({
        title: t("已提交发布审批"),
        content: t("发布到 {toEnv} 属受保护环境,需项目 owner 在「项目空间」页批准;批准后资源才会出现在 {toEnv} 环境,批准人会得到「切到 {toEnv} 查看」的入口。", { toEnv }),
        okText: t("去项目空间审批"),
        cancelText: t("知道了"),
        // antd 的 ButtonProps 类型不含 data-*,运行时会原样透传到 <button>(无头判据靠它定位)
        okButtonProps: { "data-testid": "promote-goto-approvals" } as unknown as React.ComponentProps<typeof Button>,
        onOk: () => router.push("/projects"),
      });
      window.dispatchEvent(new CustomEvent(PROMOTED_EVENT, { detail: { type, id, toEnv, pending: true } }));
      return;
    }
    const targetId: string = d.data?.targetId || id;
    const action = d.data?.created ? t("新建") : t("更新");
    notification.success({
      key: "promote",
      message: t("已发布到 {toEnv}", { toEnv }),
      description: t("已{action}目标环境里的这份资源。你现在看的是 {cur} 环境,切到 {toEnv} 才能看到它。", { action, cur, toEnv }),
      duration: 15,
      btn: (
        <Button data-testid="promote-goto-env" size="small" type="primary"
          onClick={() => { notification.destroy("promote"); gotoEnvResource(toEnv, type, targetId); }}>
          {t("切到 {env} 环境查看", { env: toEnv })}
        </Button>
      ),
    });
    window.dispatchEvent(new CustomEvent(PROMOTED_EVENT, { detail: { type, id, toEnv, targetId, pending: false } }));
    onPromoted?.();
  };

  const items = [
    { key: "cur", disabled: true, label: <span data-testid="promote-current-env">{t("当前环境 {env} · 顺序 dev → staging → prod", { env: cur })}</span> },
    { type: "divider" as const },
    ...targets.map((e) => ({
      key: e,
      label: (
        <span data-testid={`promote-to-${e}`}>
          {t("发布到 {env}", { env: e })}{isProtectedEnv(e) ? `（${t("需审批")}）` : ""}
        </span>
      ),
    })),
  ];

  return (
    <Dropdown menu={{ items, onClick: ({ key }) => { if (key !== "cur") promote(String(key)); } }}>
      <Button data-testid="promote-btn" icon={<DeploymentUnitOutlined />}>{t("发布到环境")}</Button>
    </Dropdown>
  );
}
