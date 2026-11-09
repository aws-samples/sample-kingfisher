"use client";
// 数据湖表桶路由(设计稿 §6.9)—— 离线计算 Glue 作业 / EMR 作业「高级属性」里的「数据湖表桶」块(两处共用)。
//   · 路由多选(缺省全部 = 不声明;选了子集就落 lakeBuckets),每个被选桶一个读 / 写开关(D3);
//   · 「缺省目录」单选(spark.sql.defaultCatalog;两段名走它,跨目录仍要三段名 —— 页面写明 Spark 语义);
//   · 只读清单「本作业可用的目录:别名 → 桶」+「复制三段名示例」(用户不必手敲账号 / 区 / ARN)。
//   🔴 首帧只渲染 props;路由表在 useEffect 里按 targetId 拉(URL 带 targetId=);剪贴板只在点击事件里碰。
import React, { useEffect, useMemo, useState } from "react";
import { Button, Segmented, Select, Space, Tag, Typography } from "antd";
import { CopyOutlined, ReloadOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { PLATFORM_ROUTE_ALIAS, threePartNameExample, type LakeAccessMode, type LakeTier } from "@/lib/lake/routes-grammar";
import type { LakeRouteView } from "./LakeRoutesCard";

const { Text } = Typography;

export interface JobLakeDeclarationValue {
  lakeBuckets?: Array<{ bucket: string; access: LakeAccessMode }>;
  defaultCatalogAlias?: string;
}

export interface JobLakeBucketsBlockProps {
  /** 作业绑定的第一个执行区(路由表按它取;多区作业各区路由表可能不同,页面提示) */
  targetId: string;
  engine: "glue" | "emr";
  value: JobLakeDeclarationValue;
  onChange: (next: JobLakeDeclarationValue) => void;
  multiTargetHint?: boolean;
  size?: "small" | "middle";
}

type LoadState = { status: "idle" | "loading" | "ok" | "error"; routes: LakeRouteView[]; error?: string };

/** 示例脚本(复制用;按引擎给读路由图的那一行)。 */
export function lakeExampleSnippet(engine: "glue" | "emr", routes: readonly Pick<LakeRouteView, "alias">[], defaultAlias?: string): string {
  const first = routes[0]?.alias ?? PLATFORM_ROUTE_ALIAS;
  const second = routes[1]?.alias ?? first;
  const readMap = engine === "glue"
    ? `args = getResolvedOptions(sys.argv, ["JOB_NAME", "bgp_lake_catalogs"])\ncatalogs = dict(kv.split("=", 1) for kv in args["bgp_lake_catalogs"].split(","))`
    : `catalogs = dict(kv.split("=", 1) for kv in spark.conf.get("spark.bgp.lakeCatalogs").split(","))`;
  const twoPart = defaultAlias ? `\n# 缺省目录 ${defaultAlias}:两段名 <命名空间>.<表> 等价于 ${threePartNameExample(defaultAlias)}` : "";
  return `${readMap}\n# 跨目录读写必须用三段名 <别名>.<命名空间>.<表>:\nspark.sql("INSERT OVERWRITE TABLE ${threePartNameExample(second, "<命名空间>", "<结果表>")} SELECT * FROM ${threePartNameExample(first, "<命名空间>", "<源表>")}")${twoPart}`;
}

export default function JobLakeBucketsBlock(props: JobLakeBucketsBlockProps) {
  const t = useT();
  const { targetId, engine, value, onChange, multiTargetHint, size = "small" } = props;
  const [state, setState] = useState<LoadState>({ status: "idle", routes: [] });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!targetId) { setState({ status: "idle", routes: [] }); return; }
    let alive = true;
    setState((s) => ({ ...s, status: "loading" }));
    fetch(`/api/lake-routes?targetId=${encodeURIComponent(targetId)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok || !d?.success) throw new Error(d?.error?.message || `HTTP ${r.status}`);
        return (d.data?.routes ?? []) as LakeRouteView[];
      })
      .then((routes) => { if (alive) setState({ status: "ok", routes }); })
      .catch((e: unknown) => { if (alive) setState({ status: "error", routes: [], error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [targetId, reload]);

  const declared = value.lakeBuckets;
  const declaredBuckets = declared?.map((d) => d.bucket);
  /** 本作业实际可用的目录:声明了就是声明的子集(按路由表顺序),否则全部 */
  const effective = useMemo(() => {
    if (!declared) return state.routes;
    return state.routes.filter((r) => declaredBuckets!.includes(r.bucket));
  }, [state.routes, declared, declaredBuckets]);

  const selectOptions = state.routes.map((r) => ({
    value: r.bucket,
    label: (
      <span data-testid="job-lake-option" data-bucket={r.bucket} data-alias={r.alias} data-tier={r.tier} data-writable={r.writable ? "1" : "0"}>
        <code>{r.alias}</code> · {r.tier} · <Text type="secondary">{r.bucket}</Text>{!r.writable && <Tag style={{ marginLeft: 6 }}>{t("只读")}</Tag>}
      </span>
    ),
  }));

  const setDeclared = (buckets: string[]) => {
    if (buckets.length === 0 || buckets.length === state.routes.length && state.routes.every((r) => buckets.includes(r.bucket)) && !declared) {
      // 全选 / 清空 = 不声明(缺省全部路由)
      onChange({ ...value, lakeBuckets: undefined, defaultCatalogAlias: value.defaultCatalogAlias });
      return;
    }
    const prev = new Map((declared ?? []).map((d) => [d.bucket, d.access]));
    const next = state.routes.filter((r) => buckets.includes(r.bucket)).map((r) => ({ bucket: r.bucket, access: prev.get(r.bucket) ?? (r.writable ? "write" : "read") as LakeAccessMode }));
    const keepDefault = value.defaultCatalogAlias && next.some((d) => state.routes.find((r) => r.bucket === d.bucket)?.alias === value.defaultCatalogAlias);
    onChange({ lakeBuckets: next, defaultCatalogAlias: keepDefault ? value.defaultCatalogAlias : undefined });
  };

  const setAccess = (bucket: string, access: LakeAccessMode) => {
    onChange({ ...value, lakeBuckets: (declared ?? []).map((d) => (d.bucket === bucket ? { bucket, access } : d)) });
  };

  const copyExample = async () => {
    const text = lakeExampleSnippet(engine, effective, value.defaultCatalogAlias);
    try {
      await navigator.clipboard.writeText(text);
      // antd message 在父组件已有;这里用最轻的反馈
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const [copied, setCopied] = useState(false);

  return (
    <div data-testid="job-lake-block">
      <Space wrap size={8} style={{ marginBottom: 4 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{t("数据湖表桶(不选 = 本区全部路由;选了子集则只注入这些目录、按桶量权限):")}</Text>
        <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => setReload((n) => n + 1)} data-testid="job-lake-reload">{t("刷新")}</Button>
      </Space>
      {state.status === "error" && <div><Text type="danger" style={{ fontSize: 12 }} data-testid="job-lake-error">{t("路由表读取失败:{msg}", { msg: state.error || "" })}</Text></div>}
      {multiTargetHint && <div><Text type="warning" style={{ fontSize: 12 }}>{t("作业绑了多个区:这里按第一个区的路由表显示,保存时每个绑定区各按自己的路由表校验")}</Text></div>}
      <Select<string[]>
        mode="multiple"
        size={size}
        style={{ width: "100%", maxWidth: 720 }}
        placeholder={state.status === "loading" ? t("正在读取路由表…") : t("全部路由(缺省)")}
        value={declaredBuckets ?? []}
        onChange={setDeclared}
        options={selectOptions}
        optionFilterProp="value"
        data-testid="job-lake-buckets"
        data-lake-status={state.status}
      />
      {declared && declared.length > 0 && (
        <Space direction="vertical" size={2} style={{ marginTop: 4 }} data-testid="job-lake-access-list">
          {declared.map((d) => {
            const r = state.routes.find((x) => x.bucket === d.bucket);
            return (
              <Space key={d.bucket} size={8}>
                <code>{r?.alias ?? d.bucket}</code>
                <Text type="secondary" style={{ fontSize: 12 }}>{d.bucket}</Text>
                <Segmented
                  size="small"
                  value={d.access}
                  onChange={(v) => setAccess(d.bucket, v as LakeAccessMode)}
                  options={[{ label: t("读"), value: "read" }, { label: t("写"), value: "write", disabled: r ? !r.writable : false }]}
                  data-testid="job-lake-access"
                  data-bucket={d.bucket}
                />
              </Space>
            );
          })}
        </Space>
      )}
      <Space wrap size={8} style={{ marginTop: 6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{t("缺省目录(两段名走它;跨目录仍要三段名):")}</Text>
        <Select<string>
          size={size}
          allowClear
          style={{ width: 220 }}
          placeholder={t("不设(两段名落 Spark 会话目录)")}
          value={value.defaultCatalogAlias}
          onChange={(v) => onChange({ ...value, defaultCatalogAlias: v || undefined })}
          options={effective.map((r) => ({ value: r.alias, label: `${r.alias} → ${r.bucket}` }))}
          data-testid="job-default-catalog"
        />
      </Space>
      <div style={{ marginTop: 6 }} data-testid="job-lake-catalogs-hint">
        <Text type="secondary" style={{ fontSize: 12 }}>{t("本作业可用的目录:")}</Text>
        {effective.length === 0
          ? <Text type="secondary" style={{ fontSize: 12 }}> {state.status === "ok" ? t("无(先在「系统设置 → 数据湖表桶与路由」登记)") : "…"}</Text>
          : effective.map((r) => <Tag key={r.bucket} data-testid="job-lake-catalog" data-alias={r.alias} data-bucket={r.bucket}><code>{r.alias}</code> → {r.bucket}</Tag>)}
        <Button size="small" type="link" icon={<CopyOutlined />} onClick={copyExample} data-testid="job-lake-copy-example">{copied ? t("已复制") : t("复制三段名示例")}</Button>
      </div>
    </div>
  );
}
