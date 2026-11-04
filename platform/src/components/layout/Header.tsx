"use client";

import React, { useEffect, useState } from "react";
import { Layout, Avatar, Dropdown, Select, Tag, Tooltip } from "antd";
import { UserOutlined, LogoutOutlined, LoginOutlined, KeyOutlined, AppstoreOutlined, DeploymentUnitOutlined, BgColorsOutlined, CheckOutlined, AppstoreAddOutlined, GlobalOutlined } from "@ant-design/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useRouter } from "next/navigation";
import { getActiveProject, setActiveProject, getActiveEnv, setActiveEnv } from "@/lib/projects/active";
import { projectDisplayName, ENV_COLOR } from "@/lib/projects/constants";
import { useSkin } from "@/lib/skins/ThemeProvider";
import { useT } from "@/lib/i18n/useT";
import LanguageSwitcher from "@/lib/i18n/LanguageSwitcher";
import CopilotLauncher from "@/components/copilot/CopilotLauncher";
// 顶栏 ❓ 打开「操作指引」(本页怎么用 / 快速上手 / 多区域与合规)
import { QuestionCircleOutlined } from "@ant-design/icons";
import { useGuide } from "@/components/guide/GuideProvider";
// 顶栏第三层「执行范围」(项目空间 → 环境 → 执行范围;50 INTERACTION §9.2)
import ScopeSelect from "@/components/scope/ScopeSelect";
import ChangePasswordModal from "@/components/layout/ChangePasswordModal";

const { Header: AntHeader } = Layout;

interface ProjectOpt {
  projectId: string;
  name: string;
  role: string;
}

const roleColor: Record<string, string> = { owner: "red", editor: "blue", viewer: "default" };
// 颜色单一作者(lib/projects/constants.ts ENV_COLOR),资源 EnvTag 与各环境发布状态同一张表
const envColor: Record<string, string> = ENV_COLOR;
const ENV_OPTS = [
  { value: "dev", label: "dev" },
  { value: "staging", label: "staging" },
  { value: "prod", label: "prod" },
];

export default function Header() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const { skinId, setSkinId, skins } = useSkin();
  const t = useT();
  const { openGuide } = useGuide();
  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  const [active, setActive] = useState<string>("");
  const [env, setEnv] = useState<string>("dev");
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => {
    setActive(getActiveProject());
    setEnv(getActiveEnv());
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const d = await res.json();
        const list: ProjectOpt[] = d?.success ? d.data : Array.isArray(d) ? d : [];
        setProjects(list);
        // If the persisted active project is no longer visible, fall back to the first.
        const cur = getActiveProject();
        if (list.length && !list.some((p) => p.projectId === cur)) {
          setActiveProject(list[0].projectId);
          setActive(list[0].projectId);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const onSwitch = (projectId: string) => {
    setActiveProject(projectId);
    setActive(projectId);
    // Reload so every page re-fetches its data scoped to the new project.
    window.location.reload();
  };

  const onSwitchEnv = (e: string) => {
    setActiveEnv(e);
    setEnv(e);
    window.location.reload();
  };

  const activeRole = projects.find((p) => p.projectId === active)?.role;

  const items = user
    ? [
        { key: "user", label: user.getUsername(), disabled: true },
        // 🔴 生产上线批次 A:登录用户在页面上改自己的密码
        { key: "change-password", icon: <KeyOutlined />, label: <span data-testid="menu-change-password">{t("修改密码")}</span>, onClick: () => setPwOpen(true) },
        { key: "logout", icon: <LogoutOutlined />, label: t("退出登录"), onClick: () => { logout(); router.push("/login"); } },
      ]
    : [
        { key: "login", icon: <LoginOutlined />, label: t("登录"), onClick: () => router.push("/login") },
      ];

  // 主题皮肤下拉:12 款即时切换(当前项打勾)+ 打开完整风格目录。
  const skinMenuItems = [
    { key: "skin-title", label: <span style={{ fontSize: 12, color: "#90a4c0" }}>{t("主题皮肤 · 点击即时全站生效")}</span>, disabled: true },
    { type: "divider" as const },
    ...skins.map((s) => ({
      key: s.id,
      icon: (
        <span
          style={{
            display: "inline-block", width: 12, height: 12, borderRadius: 3,
            background: s.gradient, verticalAlign: "middle",
          }}
        />
      ),
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 150 }}>
          <span style={{ flex: 1 }}>{s.name}</span>
          <span style={{ fontSize: 10, color: "#90a4c0" }}>{s.mode === "light" ? t("亮") : t("暗")}</span>
          {s.id === skinId && <CheckOutlined style={{ color: "#22d3ee", fontSize: 12 }} />}
        </span>
      ),
      onClick: () => setSkinId(s.id),
    })),
    { type: "divider" as const },
    { key: "gallery", icon: <AppstoreAddOutlined />, label: t("打开完整风格目录…"), onClick: () => router.push("/theme-gallery") },
  ];

  return (
    <AntHeader style={{ background: "var(--bgp-sider-bg, rgba(8,13,24,0.72))", backdropFilter: "blur(8px)", borderBottom: "1px solid var(--bgp-panel-border, rgba(34,211,238,0.16))", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AppstoreOutlined style={{ color: "#22d3ee" }} />
        <span style={{ color: "#90a4c0", fontSize: 13 }}>{t("项目空间")}</span>
        <Tooltip title={t("切换当前项目空间（影响数据源/同步/编排/作业等资源的可见范围）")}>
          <Select
            size="small"
            style={{ minWidth: 180 }}
            value={active || undefined}
            placeholder={t("选择项目空间")}
            onChange={onSwitch}
            options={projects.map((p) => ({ value: p.projectId, label: projectDisplayName(p.name, p.projectId, t) }))}
          />
        </Tooltip>
        {activeRole && <Tag color={roleColor[activeRole] || "default"}>{activeRole}</Tag>}
        <span style={{ marginLeft: 16, color: "#90a4c0", fontSize: 13 }}>
          <DeploymentUnitOutlined /> {t("环境")}
        </span>
        <Tooltip title={t("切换当前环境（dev/staging/prod）；资源按项目+环境隔离，发布到 prod 需审批。看不到刚发布的资源?先把这里切到目标环境。")}>
          <Select
            data-testid="env-switcher"
            size="small"
            style={{ width: 110 }}
            value={env}
            onChange={onSwitchEnv}
            options={ENV_OPTS}
          />
        </Tooltip>
        <Tag data-testid="header-env-tag" data-env={env} color={envColor[env] || "default"}>{env}</Tag>
        {/* 第三层「执行范围」。🔴 刻意不叫 Region:选中值是 targetId
            (同 region 可有多账号/多 cell,按 region 键会串身份)。切换**不重载**(与上面两个选择器不同,
            那两个是 window.location.reload;范围切换只改 URL、不离开当前页 —— 护栏 4)。 */}
        <span style={{ marginLeft: 16, color: "#90a4c0", fontSize: 13 }}>
          <GlobalOutlined /> {t("执行范围")}
        </span>
        <ScopeSelect />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Tooltip title={t("操作指引")}>
          <QuestionCircleOutlined data-testid="guide-open-btn" onClick={() => openGuide("page")} style={{ color: "var(--bgp-primary, #22d3ee)", fontSize: 18, cursor: "pointer" }} />
        </Tooltip>
        <CopilotLauncher />
        <LanguageSwitcher />
        <Dropdown menu={{ items: skinMenuItems }} trigger={["click"]} placement="bottomRight">
          <Tooltip title={t("切换主题皮肤")}>
            <BgColorsOutlined style={{ color: "var(--bgp-primary, #22d3ee)", fontSize: 18, cursor: "pointer" }} />
          </Tooltip>
        </Dropdown>
        <Dropdown menu={{ items }}>
          <Avatar icon={<UserOutlined />} style={{ cursor: "pointer" }} />
        </Dropdown>
      </div>
      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </AntHeader>
  );
}
