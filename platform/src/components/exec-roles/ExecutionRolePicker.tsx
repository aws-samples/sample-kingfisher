"use client";

// 序 72 B-139(模块 56)—— 「执行角色」选择器(离线计算 Glue / EMR、数据同步 Glue 通道、实时计算 Flink 四处共用)。
//
// 改动前四处都是自由文本「执行角色 ARN」,文案承诺「可填自定义角色」而平台任务角色根本传不出去(客户现网 2026-11-03 绑不上)。
// 现在与 AWS 控制台「IAM role」下拉同口径:下拉三组(平台默认 · 角色顾问生成 · 自建)+「刷新」(IAM 里新建角色后不用退出页面)
// + 「手动输入 ARN」兜底(存量 / 旧客户端口径不变:值仍是 `executionRoleArn` 字符串,空 = 平台默认)+「检查权限」(保存前先量)。
// 角色顾问面板保留在其下:一键创建成功 ⇒ 选中它并刷新候选(新角色立刻出现在「角色顾问生成」组)。
//
// 🔴 Form.Item 注入的 `id` 必须透传到 Select / Input(B-94 教训:漏传 ⇒ 字段 id 消失,无头判据与无障碍都找不到它)。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import { ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import RoleAdvisorPanel from "@/components/role-advisor/RoleAdvisorPanel";
import type { RoleAdviceRequest } from "@/lib/role-advisor";
import type { ExecRoleCandidates, ExecRoleEngine } from "@/lib/execution-role/types";
import { SERVICE_PRINCIPAL_BY_ENGINE } from "@/lib/execution-role/types";
import type { PreflightResult } from "@/lib/role-advisor/preflight";
import { useT } from "@/lib/i18n/useT";

const { Text } = Typography;

export interface ExecutionRolePickerProps {
  engine: ExecRoleEngine;
  /** 落点(平台默认项按它解析;空 ⇒ 不拉候选,提示先选执行环境)。 */
  targetId: string;
  /** 当前值;"" / undefined = 平台默认。 */
  value?: string;
  onChange?: (roleArn: string) => void;
  isAdmin?: boolean;
  /** 作业引用的 S3 URI(Glue 两组依赖字段),「检查权限」时一起量。 */
  extraS3Uris?: string[];
  /** 脚本正文(里面的 s3:// 字面也量)。 */
  scriptCode?: string;
  /** 透传给角色顾问面板。 */
  advisorRequest: RoleAdviceRequest;
  size?: "small" | "middle";
  /** antd Form.Item 注入。 */
  id?: string;
  /** 多区作业提示(绑了多个区时平台默认角色按各区解析)。 */
  multiTargetHint?: boolean;
}

export default function ExecutionRolePicker(props: ExecutionRolePickerProps) {
  const { engine, targetId, value, onChange, isAdmin = false, extraS3Uris, scriptCode, advisorRequest, size = "middle", id, multiTargetHint } = props;
  const t = useT();
  const current = (value || "").trim();
  const [cands, setCands] = useState<ExecRoleCandidates | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [manual, setManual] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<PreflightResult | null>(null);
  const [checkErr, setCheckErr] = useState("");
  const service = SERVICE_PRINCIPAL_BY_ENGINE[engine];

  const load = useCallback(async (notify: boolean) => {
    if (!targetId) { setCands(null); return; }
    setLoading(true); setLoadErr("");
    try {
      const res = await fetch(`/api/exec-roles/candidates?engine=${encodeURIComponent(engine)}&targetId=${encodeURIComponent(targetId)}`);
      const d = await res.json();
      if (!d?.success) throw new Error(d?.error?.message || `HTTP ${res.status}`);
      setCands(d.data as ExecRoleCandidates);
      if (notify) message.success(t("已刷新,{n} 个可选角色", { n: (d.data as ExecRoleCandidates).total }));
    } catch (e: any) {
      setCands(null);
      setLoadErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [engine, targetId, t]);

  useEffect(() => { void load(false); }, [load]);
  // 换了角色 ⇒ 上一次的检查结论作废
  useEffect(() => { setCheck(null); setCheckErr(""); }, [current, targetId]);

  const options = useMemo(() => {
    const platformName = cands?.groups.platform[0]?.name;
    const groups: { label: string; options: { label: string; value: string; title?: string }[] }[] = [
      {
        label: t("平台默认(推荐,权限齐)"),
        options: [{ value: "", label: platformName ? t("平台默认角色 · {name}", { name: platformName }) : t("平台默认角色") }],
      },
    ];
    if (cands?.groups.advisor.length) {
      groups.push({ label: t("角色顾问生成"), options: cands.groups.advisor.map((r) => ({ value: r.arn, label: r.name, title: r.arn })) });
    }
    if (cands?.groups.custom.length) {
      groups.push({
        label: t("自建角色(需信任 {service},并能读作业依赖所在的桶)", { service }),
        options: cands.groups.custom.map((r) => ({ value: r.arn, label: r.name, title: r.arn })),
      });
    }
    const known = new Set(groups.flatMap((g) => g.options.map((o) => o.value)));
    if (current && !known.has(current)) {
      groups.push({ label: t("当前值(不在候选里)"), options: [{ value: current, label: current, title: current }] });
    }
    return groups;
  }, [cands, current, service, t]);

  const runCheck = async () => {
    if (!current || !targetId) return;
    setChecking(true); setCheck(null); setCheckErr("");
    try {
      const res = await fetch("/api/exec-roles/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine, targetId, roleArn: current, extraS3Uris: extraS3Uris ?? [], scriptCode }),
      });
      const d = await res.json();
      if (!d?.success) throw new Error(d?.error?.message || `HTTP ${res.status}`);
      setCheck(d.data as PreflightResult);
    } catch (e: any) {
      setCheckErr(String(e?.message || e));
    } finally {
      setChecking(false);
    }
  };

  const checkTag = check
    ? check.ok && !check.unverifiable
      ? <Tag color="green" data-testid="exec-role-check-ok">{t("权限齐(量了 {n} 条)", { n: check.checked })}</Tag>
      : check.ok && check.unverifiable
        ? <Tag color="orange" data-testid="exec-role-check-unverifiable">{t("量不了:{why}", { why: check.unverifiable })}</Tag>
        : <Tag color="red" data-testid="exec-role-check-gaps">{check.gaps.length ? t("缺 {n} 条权限", { n: check.gaps.length }) : t("不可用")}</Tag>
    : null;

  return (
    <div data-testid={`exec-role-picker-${engine}`}>
      <Space.Compact style={{ width: "100%" }}>
        {manual ? (
          <Input
            id={id}
            size={size}
            allowClear
            value={current}
            data-testid="exec-role-manual-input"
            placeholder={t("留空=平台默认角色;或填 arn:aws:iam::<账号>:role/<角色名>")}
            onChange={(e) => onChange?.(e.target.value)}
          />
        ) : (
          <Select
            id={id}
            size={size}
            showSearch
            style={{ flex: 1, minWidth: 0 }}
            value={current}
            loading={loading}
            disabled={!targetId}
            options={options}
            optionFilterProp="label"
            data-testid="exec-role-select"
            placeholder={targetId ? t("选择执行角色") : t("先选择执行环境")}
            onChange={(v) => onChange?.(String(v || ""))}
          />
        )}
        <Tooltip title={t("重新读取账号里的 IAM 角色(刚建的角色不用退出页面)")}>
          <Button size={size} icon={<ReloadOutlined />} loading={loading} disabled={!targetId} data-testid="exec-role-refresh" onClick={() => void load(true)}>
            {t("刷新")}
          </Button>
        </Tooltip>
        <Button size={size} data-testid="exec-role-manual-toggle" onClick={() => setManual((m) => !m)}>
          {manual ? t("从列表选择") : t("手动输入 ARN")}
        </Button>
        <Tooltip title={t("保存前先量:角色存在 / 信任 {service} / 必备权限 + 作业引用的每个 S3 对象", { service })}>
          <Button size={size} icon={<SafetyCertificateOutlined />} loading={checking} disabled={!current || !targetId} data-testid="exec-role-check" onClick={() => void runCheck()}>
            {t("检查权限")}
          </Button>
        </Tooltip>
      </Space.Compact>
      <div style={{ marginTop: 4 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t("执行角色决定作业能访问哪些 AWS 资源。留空 = 平台默认角色(权限齐);自建角色须信任 {service},并能读作业依赖库 / 脚本引用到的桶。", { service })}
        </Text>
        {multiTargetHint ? <Text type="secondary" style={{ fontSize: 12, display: "block" }}>{t("多区作业:平台默认角色按各区自己的角色解析;自建角色对每个区都会预检。")}</Text> : null}
        {loadErr ? <Alert type="error" showIcon style={{ marginTop: 4 }} message={t("读取角色候选失败:{why}", { why: loadErr })} description={t("可切到「手动输入 ARN」继续填写。")} /> : null}
        {cands && !loadErr ? (
          <Text type="secondary" style={{ fontSize: 12, display: "block" }} data-testid="exec-role-count">
            {t("候选 {n} 个(平台默认 {p} · 顾问生成 {a} · 自建 {c})", { n: cands.total, p: cands.groups.platform.length, a: cands.groups.advisor.length, c: cands.groups.custom.length })}
          </Text>
        ) : null}
        {checkTag ? <div style={{ marginTop: 4 }}>{checkTag}</div> : null}
        {check && !check.ok ? (
          <Alert type="error" showIcon style={{ marginTop: 4 }} message={t("这个角色现在还不能用")} description={<pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>{check.message}</pre>} />
        ) : null}
        {check && check.ok && check.unverifiable ? <Alert type="warning" showIcon style={{ marginTop: 4 }} message={check.message} /> : null}
        {checkErr ? <Alert type="error" showIcon style={{ marginTop: 4 }} message={t("检查权限失败:{why}", { why: checkErr })} /> : null}
      </div>
      <div style={{ marginTop: 8 }}>
        <RoleAdvisorPanel
          request={advisorRequest}
          isAdmin={isAdmin}
          onFilled={(arn) => { onChange?.(arn); void load(false); }}
        />
      </div>
    </div>
  );
}
