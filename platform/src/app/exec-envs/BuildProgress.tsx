"use client";

// 部署实时进度(50 INTERACTION §1.2 Step3 线框 + DESIGN §12.4)。
//
// 数据源(照 §12.4 定案,不是线框里的旧口径):
//   · 整体 phase 来自 CodeBuild(粗粒度:IN_PROGRESS/SUCCEEDED/FAILED…);
//   · **逐栈**来自目标 region 的 CloudFormation DescribeStacks(CodeBuild phase 给不了逐栈);
//   · logsTail 为构建日志尾部,失败时后端降级为空串,前端相应隐藏。
// 轮询 3s;phase 落终态即停(手动「刷新」仍可用)。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Collapse, Empty, List, Space, Spin, Typography } from "antd";
import { CheckCircleTwoTone, CloseCircleTwoTone, ReloadOutlined, SyncOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { isHome } from "@/lib/exec-env/target-id";
import { getBuildStatus, type BuildStatus } from "./api";

const { Text } = Typography;

/** CodeBuild 整体状态的终态集合 —— 到达即停轮询("none" = 没有 build 在跑,也停)。 */
const TERMINAL_PHASES = new Set(["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT", "none"]);

function stackIcon(status: string) {
  if (status.includes("IN_PROGRESS")) return <SyncOutlined spin style={{ color: "#1677ff" }} />;
  if (status.includes("ROLLBACK") || status.includes("FAILED")) return <CloseCircleTwoTone twoToneColor="#ff4d4f" />;
  if (status.includes("COMPLETE")) return <CheckCircleTwoTone twoToneColor="#52c41a" />;
  return <Badge status="default" />;
}

function phaseBadge(phase: string): { status: "processing" | "success" | "error" | "default"; text: string } {
  if (phase === "IN_PROGRESS") return { status: "processing", text: "构建中" };
  if (phase === "SUCCEEDED") return { status: "success", text: "构建成功" };
  if (phase === "none") return { status: "default", text: "当前无构建" };
  if (TERMINAL_PHASES.has(phase)) return { status: "error", text: `构建失败(${phase})` };
  return { status: "processing", text: phase };
}

export default function BuildProgress({ targetId, buildId }: { targetId: string; buildId?: string }) {
  const t = useT();
  // 🔴 **主控区(home)这一整块结构上无意义,而且会说假话**(2026-09-08 用户在全新账号的页面上一眼看到):
  //   ① `phase` 来自 CodeBuild,而 home **从不经** broker + CodeBuild ⇒ 恒 `none` ⇒ 徽标「当前无构建」;
  //   ② 逐栈来自 `candidateStackNames()`,它按 `execEnvStackName(targetId, comp)` 推名 ⇒ 对 home 推出
  //      `BgpExecEnv-tgt-home-*` 这些**永不存在**的栈(home 的栈是 deploy-all 建的 `BgpVpcStack` /
  //      `BgpRedshiftStack` / `BgpMwaaStack` …),逐栈指名查询全部 does-not-exist 被当「尚未创建」跳过 ⇒ 空态
  //      「目标 region 暂无本环境的栈(部署刚开始或尚未部署)」。
  //   于是页面同屏出现矛盾:上面说「尚未部署」,下面 16 项探活与组件清单全绿。**界面说假话比缺信息更糟**。
  // 判别放在**本组件自己**身上(不是在调用方加 `!isHome &&`):这样任何将来新增的挂载点都不可能再犯
  //   (现有挂载点 = TargetDetail 详情页 + CreateWizard 部署后原地转进度)。
  const homeTarget = isHome(targetId);
  const [status, setStatus] = useState<BuildStatus | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fetchOnce = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getBuildStatus(targetId, buildId);
      setStatus(s);
      setError("");
      if (TERMINAL_PHASES.has(s.phase)) stopPolling();
    } catch (e) {
      // 轮询失败不清已有数据(网络抖动时保留最后一帧);报错但继续轮询,由用户决定何时放弃。
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [targetId, buildId, stopPolling]);

  useEffect(() => {
    if (homeTarget) return; // home 没有 build、也没有 BgpExecEnv-* 栈 ⇒ 一次都不该去打 CodeBuild / CFN
    fetchOnce();
    timerRef.current = setInterval(fetchOnce, 3000);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, buildId, homeTarget]);

  const badge = phaseBadge(status?.phase ?? "none");

  // 🔴 home:把真相摆出来 —— 它由 deploy-all / redeploy-platform 直接部署,进度与逐栈本就不在这条通道上;
  //   同时指明「该看哪里」(下面的初始化 / 探活 + 组件清单才是 home 就位的真值源)。
  if (homeTarget) {
    return (
      <Alert
        type="info"
        showIcon
        data-testid="home-build-progress-na"
        message={t("主控区由 deploy-all / redeploy-platform 直接部署,不经执行环境部署机制(broker + CodeBuild)")}
        description={t("所以这里没有构建进度、也没有逐栈明细可看。要判断它是否就位,看下面的「初始化 / 探活」与组件清单。")}
      />
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Badge status={badge.status} text={t(badge.text)} />
        {loading ? <Spin size="small" /> : null}
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => {
            // 手动刷新 = 重启一轮(可能之前已因终态停了轮询)
            stopPolling();
            fetchOnce();
            timerRef.current = setInterval(fetchOnce, 3000);
          }}
        >
          {t("刷新")}
        </Button>
      </Space>
      {error ? <Alert type="warning" showIcon message={t("进度获取失败:{msg}", { msg: error })} style={{ marginBottom: 8 }} /> : null}

      {status && status.stacks.length > 0 ? (
        <List
          size="small"
          dataSource={status.stacks}
          renderItem={(s) => (
            <List.Item style={{ padding: "4px 0" }}>
              <Space>
                {stackIcon(s.status)}
                <Text code style={{ fontSize: 12 }}>
                  {s.name}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {s.status}
                </Text>
              </Space>
            </List.Item>
          )}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("目标 region 暂无本环境的栈(部署刚开始或尚未部署)")}
        />
      )}

      {status?.logsTail ? (
        <Collapse
          size="small"
          style={{ marginTop: 8 }}
          items={[
            {
              key: "logs",
              label: t("查看构建日志(尾部)"),
              children: (
                <pre style={{ fontSize: 11, maxHeight: 260, overflow: "auto", margin: 0 }}>{status.logsTail}</pre>
              ),
            },
          ]}
        />
      ) : null}
    </div>
  );
}
