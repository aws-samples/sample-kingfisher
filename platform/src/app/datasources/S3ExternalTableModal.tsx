"use client";
// 数据源页 S3 源行「建外部表(Athena 直查)」弹窗
//   选一个数据集(introspect 出的一级子前缀)⇒ 一键建 Athena 外部表 ⇒ 成功显示 `bgp_s3_ext.<表>` + 「去数据湖直查」。
// 【为什么要有页面入口】 S3 分析通道(POST …/[id]/s3-external)自 2026-07 起只有 API,用户在页面上建完 S3 源后
//   无从把它变成一张可直查的表(用户 2026-10-25 拍板「做」)。
// 【落点】外部表建在**这条源所在区**(行上的章,唯一读法 datasourceOwnerTarget;此前一律落主控区)的 Athena 工作组 / Glue 目录;
//   标题与按钮都把区说出来(护栏 2:写操作在按钮上复述目标),成功后「去数据湖直查」把 ?scope=<该区>&sql=<示例查询> 带到直查页。
// 【长操作】introspect 大桶 + 三条 DDL 常超 45s ⇒ 服务端转 202,全局 fetch 拦截器轮询到终态再整形成同形响应;本组件零感知。
import React, { useEffect, useState } from "react";
import { Modal, Select, Alert, Button, Space, Tag, Collapse } from "antd";
import { CloudServerOutlined, ConsoleSqlOutlined } from "@ant-design/icons";
import type { DataSource } from "@/types/datasource";
import { useT } from "@/lib/i18n/useT";
// 取数据集清单的唯一作者(S3 源直连 introspect 回数组;与「浏览表」同一条路)
import { fetchSourceTables, type SourceTableInfo } from "@/lib/datasource/tables-client";

/** POST …/s3-external 成功响应的 data(与 lib/datasource/long-ops.ts 执行体回的字段同名) */
export interface S3ExternalTableResult {
  database: string;
  table: string;
  qualifiedName: string;
  location: string;
  format: string;
  columns: Array<{ name: string; type?: string }>;
  ddl: string;
  sampleQuery: string;
  targetId: string;
  region: string;
}

/** 「去数据湖直查」的链接:单区视角锚到表真落的那个区(scope = targetId 的规范形式),sql 预填示例查询。 */
export function athenaLinkFor(result: Pick<S3ExternalTableResult, "targetId" | "sampleQuery">): string {
  return `/athena?scope=${encodeURIComponent(result.targetId)}&sql=${encodeURIComponent(result.sampleQuery)}`;
}

/** 成功块(拆成纯展示组件:服务端真渲染判据直接渲它,不必把 fetch 与弹窗状态机搬进单测)。 */
export function S3ExternalTableDone({ result, region }: { result: S3ExternalTableResult; region: string }) {
  const t = useT();
  return (
    <div data-testid="ds-s3ext-done">
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 12 }}
        message={<span>{t("外部表已建好:")}<code data-testid="ds-s3ext-table">{result.qualifiedName}</code></span>}
        description={t("落在 {region} 的 Athena 目录(与这条数据源同一个区);{n} 列,格式 {format},数据位置 {location}", {
          region,
          n: result.columns.length,
          format: result.format,
          location: result.location,
        })}
      />
      <Space>
        <Button type="primary" icon={<ConsoleSqlOutlined />} href={athenaLinkFor(result)} data-testid="ds-s3ext-go-athena">
          {t("去数据湖直查")}
        </Button>
      </Space>
      <Collapse
        size="small"
        style={{ marginTop: 12 }}
        items={[{ key: "ddl", label: t("查看建表语句"), children: <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{result.ddl}</pre> }]}
      />
    </div>
  );
}

export default function S3ExternalTableModal({
  open,
  ds,
  targetId,
  region,
  onClose,
}: {
  open: boolean;
  ds?: DataSource;
  /** 这条源的落点(页面按行上的章算好传进来;弹窗不猜) */
  targetId: string;
  /** 落点的 region 显示名(页面从执行范围清单取;取不到就是 targetId) */
  region: string;
  onClose: () => void;
}) {
  const t = useT();
  const [datasets, setDatasets] = useState<SourceTableInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [dataset, setDataset] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<S3ExternalTableResult | null>(null);

  useEffect(() => {
    if (!open || !ds) return;
    setDatasets([]);
    setDataset(undefined);
    setResult(null);
    setError("");
    setLoadError("");
    setLoading(true);
    let alive = true;
    fetchSourceTables(ds.datasourceId, undefined)
      .then((r) => {
        if (!alive) return;
        setDatasets(r.tables);
        // 只有一个数据集时直接选上(省一步);多个时让用户点名,不悄悄取第一个
        if (r.tables.length === 1) setDataset(r.tables[0].name);
      })
      .catch((e) => {
        if (alive) setLoadError((e as Error)?.message || t("读取数据集失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ds?.datasourceId]);

  const submit = async () => {
    if (!ds || !dataset) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/datasources/${encodeURIComponent(ds.datasourceId)}/s3-external`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false || json?.error) {
        setError(typeof json?.error === "string" ? json.error : json?.error?.message || `HTTP ${res.status}`);
        return;
      }
      setResult((json?.data ?? json) as S3ExternalTableResult);
    } catch (e) {
      setError((e as Error)?.message || t("建外部表失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const chosen = datasets.find((item) => item.name === dataset);
  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={640}
      footer={result ? <Button onClick={onClose}>{t("关闭")}</Button> : null}
      title={
        <Space size={6}>
          <CloudServerOutlined />
          {t("建外部表(Athena 直查)- {name}", { name: ds?.name || "" })}
          <Tag color="blue" data-testid="ds-s3ext-region">{region}</Tag>
        </Space>
      }
    >
      {result ? (
        <S3ExternalTableDone result={result} region={region} />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size={10}>
          <Alert
            type="info"
            showIcon
            message={t("把这条 S3 源下的一个数据集(一级子前缀)登记成 Athena 外部表,建在 {region} 的 bgp_s3_ext 库里;建好就能在数据湖直查里按表名查询。", { region })}
          />
          <div>
            <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>{t("数据集")}</div>
            <Select
              style={{ width: "100%" }}
              value={dataset}
              loading={loading}
              placeholder={loading ? t("正在读取数据集…") : t("选择要建表的数据集")}
              onChange={(v) => setDataset(v)}
              showSearch
              optionFilterProp="label"
              data-testid="ds-s3ext-dataset"
              options={datasets.map((item) => ({ value: item.name, label: `${item.name}(${t("{n} 列", { n: item.columns?.length || 0 })})` }))}
              notFoundContent={loading ? null : t("这个前缀下没有发现数据集(需要一级子前缀或直属文件)")}
            />
          </div>
          {chosen && (chosen.columns?.length || 0) === 0 && (
            <Alert type="warning" showIcon message={t("该数据集没有推断出列(CSV 需有表头;Parquet / JSON 一期由 Athena 读内嵌 schema),建表会被拒")} />
          )}
          {loadError && <Alert type="error" showIcon message={loadError} />}
          {error && <Alert type="error" showIcon data-testid="ds-s3ext-error" message={error} />}
          <Button type="primary" loading={submitting} disabled={!dataset} onClick={submit} data-testid="ds-s3ext-submit">
            {t("在 {region} 建外部表", { region })}
          </Button>
        </Space>
      )}
    </Modal>
  );
}
