"use client";
// @kf-batch 39-release-visibility —— 「运行中的平台是哪一版」的页面载体(序 39 第二刀)。
// 两个出口同一份数据与同一条文案规则:登录页页脚一行(`BuildLabel`)、系统设置「平台版本」卡(`BuildInfoCard`)。
// 事实只来自 `GET /api/public/version`(唯一作者 lib/build-info.ts);取不到就显示「构建信息不可用」,不编造。
import React, { useEffect, useState } from "react";
import { Card, Descriptions, Typography } from "antd";
import { useT } from "@/lib/i18n/useT";
import { buildLabelParts, type BuildInfo } from "@/lib/build-info";

const { Text } = Typography;

/** undefined = 还在读;null = 读失败 / 服务没给;对象 = 事实 */
export type BuildInfoState = BuildInfo | null | undefined;

export function useBuildInfo(): BuildInfoState {
  const [info, setInfo] = useState<BuildInfoState>(undefined);
  useEffect(() => {
    let alive = true;
    fetch("/api/public/version")
      .then((res) => res.json())
      .then((body) => {
        if (alive) setInfo(body?.success ? (body.data as BuildInfo) : null);
      })
      .catch(() => {
        if (alive) setInfo(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** 一行标识:`release-2026-10-13-b103` / `1ec5deb · 未发版` / 「构建信息不可用」。事实同时暴露在 data-* 上给页面判据读。 */
export function BuildLabel({ info }: { info: BuildInfoState }) {
  const t = useT();
  if (info === undefined) {
    return <Text type="secondary" data-testid="build-label" data-state="loading">…</Text>;
  }
  const parts = info ? buildLabelParts(info) : { primary: null, unreleased: false };
  if (!parts.primary) {
    return (
      <Text type="secondary" data-testid="build-label" data-state="unknown">
        {t("构建信息不可用(镜像不是从 git 克隆构建的)")}
      </Text>
    );
  }
  return (
    <Text
      type="secondary"
      data-testid="build-label"
      data-state={parts.unreleased ? "unreleased" : "release"}
      data-release-tag={info?.releaseTag ?? ""}
      data-product-commit={info?.productCommit ?? ""}
    >
      {parts.primary}
      {parts.unreleased ? ` · ${t("未发版")}` : ""}
    </Text>
  );
}

export default function BuildInfoCard({ style }: { style?: React.CSSProperties }) {
  const t = useT();
  const info = useBuildInfo();
  return (
    <Card title={t("平台版本")} size="small" style={style} extra={<BuildLabel info={info} />} data-testid="build-info-card">
      {info === undefined ? null : (
        <>
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label={t("发版标签")}>
              {info?.releaseTag ? <Text code data-testid="build-release-tag">{info.releaseTag}</Text> : <Text type="secondary">{t("无(未发版构建)")}</Text>}
            </Descriptions.Item>
            <Descriptions.Item label={t("产品提交")}>
              {info?.productCommit ? <Text code data-testid="build-product-commit">{info.productCommit}</Text> : <Text type="secondary">—</Text>}
            </Descriptions.Item>
            <Descriptions.Item label={t("提交时间")}>{info?.productCommitAt ?? "—"}</Descriptions.Item>
            <Descriptions.Item label={t("版本文件")}>{info?.version ?? "—"}</Descriptions.Item>
          </Descriptions>
          <Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
            {t("升级 / 回滚按客户生产部署手册 §7ter;对账以发版标签为准,未发版构建以产品提交为准")}
          </Text>
        </>
      )}
    </Card>
  );
}
