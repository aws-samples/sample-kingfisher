"use client";
// 「操作指引」抽屉(53 DESIGN §3 线框):
//   头部 = 「操作指引」+ 当前页 Tag;三个 tab = 本页怎么用 / 快速上手(按角色)/ 多区域与合规;每步可「去这一页」。
//   文案全部来自 lib/guide/content.ts(单一作者),本组件不拼一个字的业务说明。
import React, { useEffect, useState } from "react";
import { Button, Checkbox, Drawer, Empty, Segmented, Space, Steps, Tabs, Tag, Typography } from "antd";
import { ArrowRightOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { usePathname, useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/useT";
import { GUIDE_AUTO_KEY, JOURNEYS, MULTI_REGION_FLOW, guideForPath, type JourneyStep } from "@/lib/guide/content";
import { useGuide, type GuideTab } from "./GuideProvider";

const { Paragraph, Text } = Typography;

export default function OperationGuideDrawer() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { open, tab, setTab, close, startTour } = useGuide();
  const [role, setRole] = useState<string>(JOURNEYS[0].key);
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    try {
      setAuto(localStorage.getItem(GUIDE_AUTO_KEY) !== "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  const go = (path: string) => {
    close();
    router.push(path);
  };
  const guide = guideForPath(pathname);

  const stepsOf = (list: JourneyStep[], testid: string) =>
    list.map((s, i) => ({
      title: <span data-testid={testid}>{t(s.title)}</span>,
      description: (
        <Space direction="vertical" size={2}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t(s.desc)}</Text>
          <Button size="small" type="link" icon={<ArrowRightOutlined />} style={{ paddingInline: 0 }} data-testid="guide-goto" onClick={() => go(s.path)}>
            {t("去这一页")}
          </Button>
        </Space>
      ),
      key: `${testid}-${i}`,
    }));

  const pageTab = guide ? (
    <div data-testid="guide-page-body">
      <Paragraph style={{ marginBottom: 8 }}>
        <Text strong>{t("作用")}:</Text>
        {t(guide.what)}
      </Paragraph>
      <Text strong>{t("使用步骤")}:</Text>
      <ol style={{ margin: "4px 0 8px 0", paddingLeft: 20, lineHeight: 1.9 }}>
        {guide.steps.map((s, i) => (
          <li key={i} data-testid="guide-step">{t(s)}</li>
        ))}
      </ol>
      {guide.tips?.length ? (
        <>
          <Text strong>{t("要点")}:</Text>
          <ul style={{ margin: "4px 0 8px 0", paddingLeft: 20, lineHeight: 1.9 }}>
            {guide.tips.map((s, i) => (
              <li key={i} style={{ color: "var(--bgp-text-dim, #8fb0c2)" }}>{t(s)}</li>
            ))}
          </ul>
        </>
      ) : null}
      {guide.related?.length ? (
        <Space wrap style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t("相关页面")}:</Text>
          {guide.related.map((p) => {
            const g = guideForPath(p);
            return (
              <Button key={p} size="small" data-testid="guide-related" onClick={() => go(p)}>
                {t(g?.title ?? p)}
              </Button>
            );
          })}
        </Space>
      ) : null}
    </div>
  ) : (
    <Empty description={t("该页暂无专项指引,先看「快速上手」。")} />
  );

  const journey = JOURNEYS.find((j) => j.key === role) ?? JOURNEYS[0];

  return (
    <Drawer
      title={
        <Space>
          <QuestionCircleOutlined />
          <span>{t("操作指引")}</span>
          <Tag color="geekblue" data-testid="guide-current-page">{t(guide?.title ?? "当前页")}</Tag>
        </Space>
      }
      placement="right"
      width={560}
      open={open}
      onClose={close}
      destroyOnHidden
      data-testid="guide-drawer"
      footer={
        <Checkbox
          data-testid="guide-auto-toggle"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked);
            try {
              localStorage.setItem(GUIDE_AUTO_KEY, e.target.checked ? "1" : "0");
            } catch {
              /* ignore */
            }
          }}
        >
          {t("登录后自动打开操作指引")}
        </Checkbox>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as GuideTab)}
        items={[
          { key: "page", label: <span data-testid="guide-tab-page">{t("本页怎么用")}</span>, children: pageTab },
          {
            key: "start",
            label: <span data-testid="guide-tab-start">{t("快速上手")}</span>,
            children: (
              <div data-testid="guide-start-body">
                <Segmented
                  block
                  value={role}
                  onChange={(v) => setRole(String(v))}
                  options={JOURNEYS.map((j) => ({ value: j.key, label: <span data-testid={`guide-role-${j.key}`}>{t(j.label)}</span> }))}
                  style={{ marginBottom: 12 }}
                />
                {/* 🔴 主形态是**导览**;这份清单只是参考手册。
                    用户 2026-09-14:「不是给一个操作说明放在那里不动的东西」。 */}
                <Button type="primary" size="small" style={{ marginBottom: 10 }}
                        data-testid={`guide-start-tour-${journey.key}`}
                        onClick={() => startTour(journey.key)}>
                  {t("带我走一遍(一步步高亮该点哪里)")}
                </Button>
                <Steps direction="vertical" size="small" current={-1} items={stepsOf(journey.steps, "guide-journey-step")} />
              </div>
            ),
          },
          {
            key: "region",
            label: <span data-testid="guide-tab-region">{t("多区域与合规")}</span>,
            children: (
              <div data-testid="guide-region-body">
                <Paragraph type="secondary" style={{ fontSize: 12 }}>
                  {t("一套代码多 region 执行:环境先建好,再授权给项目,作业与查询就能选多个区一次运行;跨法域首次操作弹免责告知,全过程可审计。")}
                </Paragraph>
                <Steps direction="vertical" size="small" current={-1} items={stepsOf(MULTI_REGION_FLOW, "guide-region-step")} />
              </div>
            ),
          },
        ]}
      />
    </Drawer>
  );
}
