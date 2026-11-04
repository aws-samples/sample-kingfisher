"use client";

// @kf-batch 50-P50.2c-control-api
// 创建执行环境向导(50 INTERACTION §1.2:三步 = 选 region+命名预览 → 选组件 → 确认并一键部署)。
//
// 点「开始部署」后:POST register(服务端生成 targetId)→ POST deploy(经窄权 broker)→
// **原地转入实时进度视图**(复用 BuildProgress,与详情页同一实现)。
import React, { useMemo, useState, useEffect } from "react";
import { Alert, Button, Checkbox, Descriptions, Form, Input, Modal, Select, Space, Steps, Tag, Typography, message } from "antd";
import { ReloadOutlined, RocketOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { resourceName } from "@/lib/aws/naming";
import { COMPONENT_META, deployTarget, getCandidateRegions, previewTargetId, registerTarget } from "./api";
// @kf-batch 50-WP15-airflow-serverless(K-5 网络规模)
import { requiredComponentsFor } from "@/lib/exec-env/implemented-components";
// @kf-batch 50-W5-seg1-WP10a —— 法域格式 + 免责告知(单作者;INTERACTION v2.17 §1.2 / §4bis.4)
import { JURISDICTION_RE, HOME_JURISDICTION } from "@/lib/exec-env/residency";
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION, currentDisclaimerAck } from "@/lib/residency/disclaimer";
import BuildProgress from "./BuildProgress";

const { Text } = Typography;

// @kf-batch 50-WP27b-n-region-auto
// 🔴🔴 **这里原来是一份写死的 7 个区候选表 + 默认值 `us-west-2`,已删。**
//   用户 2026-09-20:「不能硬编码两个,应该是多区域自动的……即便是开 N 个区域,也是一样的。」
//   勘定:**后端本来就是 N 区自动的**(`registerTarget` 只校验 region 形态,任何合法区都收),
//   天花板只在这份界面清单 ⇒ 真实账号里开第 8 个区(如 `ap-south-1`)在页面上根本选不到。
//   而那个默认值本身也有案底:「那个默认值在 2026-09-15 真建出第 5 套环境」(段 w5a 的拒因原文)
//   —— 有静默合法默认值的参数是一整类缺陷的温床。
// ⇒ 候选区改为**从账号真值派生**(`GET /api/admin/exec-envs/candidate-regions`),
//   且**不给默认值**(必须显式选);已被占的区**列出来但禁用**并写明占位者
//   (「一个区域只能有一个执行环境」这条守卫从「提交后 409」提前到「选区那一刻」)。

/** Step1 命名预览要展示的 kind(全部经命名 SSOT `@/lib/aws/naming`,零本地拼名)。 */
const PREVIEW_KINDS: Array<{ kind: string; label: string; needsAccount: boolean; component?: string }> = [
  { kind: "datalakeBucket", label: "数据湖桶", needsAccount: true },
  { kind: "scriptsBucket", label: "脚本桶", needsAccount: true },
  { kind: "tableBucket", label: "S3Tables 表桶", needsAccount: false },
  { kind: "athenaWorkgroup", label: "Athena 工作组", needsAccount: false },
  { kind: "stackName", label: "CFN 栈名(core)", needsAccount: false, component: "core" },
];

export default function CreateWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** register+deploy 成功后回调(父组件刷新列表)。 */
  onCreated: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState(0);
  // 🔴 **不给默认值**:region 必须由用户显式选(默认值曾真建出第 5 套环境)
  const [region, setRegion] = useState<string | undefined>(undefined);
  const [regionOpts, setRegionOpts] = useState<Array<{ label: string; value: string; disabled?: boolean }>>([]);
  const [regionSrcErr, setRegionSrcErr] = useState<string | null>(null);
  /** 候选区清单最近一次真查的时刻 / 正在查 / 手动刷新计数(每点一次「刷新」就真查一次账号) */
  const [regionQueriedAt, setRegionQueriedAt] = useState<string | null>(null);
  /** 序 48:账号清单里控制面已放行(含预授权候选区)的区数 —— 选区下方一行只读说明 */
  const [preauthCount, setPreauthCount] = useState<number>(0);
  const [regionLoading, setRegionLoading] = useState(false);
  const [regionReload, setRegionReload] = useState(0);
  const [jurisdiction, setJurisdiction] = useState("home");
  /** @kf-batch 50-W5-seg1-WP10a:跨法域时 Step 3 的免责告知勾选(不勾 ⇒〔开始部署〕禁用;服务端另核一次) */
  const [ackChecked, setAckChecked] = useState(false);
  const crossJurisdiction = jurisdiction !== HOME_JURISDICTION;
  const jurisdictionValid = JURISDICTION_RE.test(jurisdiction);
  const [cellId, setCellId] = useState("");
  const [stage, setStage] = useState("");
  // @kf-batch 50-WP16-zero-egress:K-5 的「网络规模」单选与 EIP 配额预检**已删除** ——
  //   执行环境零出网(SPEC §3.16):不建 NAT、不占 EIP ⇒ 既没有档可选,也没有 EIP 配额要预检。
  //   Step1 只留 region / 法域 / cellId / stage,底部一行只读说明(INTERACTION v2.21 §1.1)。
  const [submitting, setSubmitting] = useState(false);
  /**
   * @kf-batch 50-PROD-B-seq33 ② —— 🔴🔴 组件**不可选**(用户 2026-10-10:「不做精简区域,所有区域都必须要完整」)。
   * 组件集由法域唯一决定(SSOT `requiredComponentsFor`;服务端注册逐项核对同一份),向导只读展示。
   */
  const required = useMemo(() => requiredComponentsFor({ isHome: false, jurisdiction }), [jurisdiction]);
  /** register+deploy 成功后置位 ⇒ Step3 原地切进度视图。 */
  const [deployed, setDeployed] = useState<{ targetId: string; buildId: string } | null>(null);
  /** @kf-batch 50-init-region-enablement 注册响应里的「控制面尚未放行该 region」提示(有则 Step3 结果区渲染) */
  const [regionNotice, setRegionNotice] = useState<string | null>(null);


  // 🔴 没选区时预览用占位串(不让整块预览消失 —— 与下面「预览失败逐条降级」同一条原则)
  const previewId = useMemo(() => previewTargetId(region || "us-east-1"), [region]);

  /** 命名预览:名字全部出自 SSOT;非法输入(如账号未填齐)逐条降级,不让整个预览区消失。 */
  const previews = useMemo(() => {
    return PREVIEW_KINDS.map(({ kind, label, needsAccount, component }) => {
      // 账号由服务端自取(用户拍板 2026-09-01)⇒ 预览用占位段,注明以真实账号为准。
      if (needsAccount) return { label, value: resourceName(kind, { targetId: previewId, account: "000000000000", component }).replace("000000000000", t("<本账号>")) };
      try {
        return { label, value: resourceName(kind, { targetId: previewId, component }) };
      } catch (e) {
        // 预览失败不该拦向导(真校验在服务端);如实展示原因。
        return { label, value: t("预览失败:{msg}", { msg: (e as Error).message.slice(0, 60) }) };
      }
    });
  }, [previewId, t]);

  // @kf-batch 50-WP27b-n-region-auto —— 打开向导时取**账号真值**的候选区。
  // 🔴 拿不到就**响亮报错**,绝不回落到一份写死的清单(那正是本刀要消灭的东西)。
  // 打开向导与点「刷新」都**真查一次**账号(路由 no-store,这里也 no-store;不在前端留缓存)。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRegionLoading(true);
    (async () => {
      try {
        const d = await getCandidateRegions();
        if (!alive) return;
        setRegionQueriedAt(d.queriedAt);
        const occ = new Map(d.occupied.map((o) => [o.region, o]));
        // @kf-batch 50-B40-candidate-blocked —— 组织策略拦住的区同样「列出来但点不动」,并写明被拦的动作(拒因层 = 组织 SCP)
        const blk = new Map((d.blocked ?? []).map((b) => [b.region, b]));
        const unv = new Map((d.orgPolicy?.unverified ?? []).map((u) => [u.region, u]));
        // 序 48:控制面已放行(含安装 / 升级时预授权的候选区)的区 —— 建完即可用;其余区构建后还要运维跑一次放行命令。
        //   在选区那一刻就说清,不让用户等 25 分钟构建完才在「检测初始化」撞见。
        const cpe = new Set(d.controlPlaneEnabled ?? []);
        setPreauthCount(cpe.size);
        setRegionOpts(
          d.regions.map((r) => {
            const o = occ.get(r);
            const b = blk.get(r);
            const u = unv.get(r);
            const pre = cpe.has(r) ? ` —— ${t("已放行,建完即可用")}` : ` —— ${t("构建后需运维放行一次")}`;
            return {
              value: r,
              // 🔴 已占的区**列出来但点不动**并写明占位者 —— 「禁用而不是隐藏」:
              //   隐藏会让用户以为那个区不存在,而真相是「它已经有一套了」(一区一套)。
              label: o
                ? `${r} —— ${t("已有执行环境")} ${o.targetId}(${o.status})`
                : b
                  ? `${r} —— ${t("被账号所在组织的策略(SCP)拦住,无法在此部署")}:${b.actions.join(", ")}`
                  : u
                    ? `${r}(${t("未能核实组织策略")})${pre}`
                    : `${r}${pre}`,
              disabled: Boolean(o) || Boolean(b),
            };
          })
        );
        setRegionSrcErr(null);
      } catch (e) {
        if (!alive) return;
        setRegionOpts([]);
        setRegionQueriedAt(null);
        setRegionSrcErr((e as Error).message.slice(0, 400));
      } finally {
        if (alive) setRegionLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, t, regionReload]);

  const reset = () => {
    setStep(0);
    setRegion(undefined);          // 🔴 重开向导不许留上一次的选择(它会变成事实上的默认值)
    setRegionSrcErr(null);
    setRegionNotice(null);
    setAckChecked(false);
    setDeployed(null);
    setSubmitting(false);
  };

  const startDeploy = async () => {
    // 🔴 fail-closed:没选区就**不许提交**(绝不替用户挑一个 —— 默认值曾真建出第 5 套环境)
    if (!region) {
      message.error(t("请先选择 region"));
      return;
    }
    setSubmitting(true);
    try {
      const reg = await registerTarget({
        region,
        // accountId/partition 服务端自取(带上会被 400)—— 严格控制面同账号。
        jurisdiction,
        // @kf-batch 50-W5-seg1-WP10a:跨法域注册必带当前版本的免责告知同意(服务端逐字核对,SPEC §2.1 v3.22)
        ...(crossJurisdiction ? { residencyAck: currentDisclaimerAck() } : {}),
        ...(cellId ? { cellId } : {}),
        ...(stage ? { stage } : {}),
        // @kf-batch 50-PROD-B-seq33 ②:完整组件集(SSOT 派生,服务端逐项核对;不提供精简形态)
        components: required,
      });
      message.success(t("已注册:{id}", { id: reg.targetId }));
      // @kf-batch 50-init-region-enablement —— 当场说清接下来会卡在哪(init 段 I-4:否则要到「检测初始化」才见 9 行红)
      setRegionNotice(reg.controlPlaneRegionEnabled === false && reg.notice ? reg.notice : null);
      try {
        const dep = await deployTarget(reg.targetId);
        setDeployed({ targetId: reg.targetId, buildId: dep.buildId });
        message.success(t("部署已触发(buildId {id})", { id: dep.buildId.slice(-12) }));
      } catch (e) {
        // register 成功但 deploy 失败:环境已在列表里(registered 态),用户可去详情页重试。
        message.error(t("注册成功但触发部署失败:{msg}(可在详情页重试)", { msg: (e as Error).message }));
        setDeployed({ targetId: reg.targetId, buildId: "" });
      }
      onCreated();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("新建执行环境")}
      open={open}
      onCancel={() => {
        reset();
        onClose();
      }}
      footer={null}
      width={720}
      destroyOnClose
    >
      <Steps
        size="small"
        current={step}
        items={[{ title: t("选 region + 命名") }, { title: t("组件(完整集)") }, { title: t("确认并部署") }]}
        style={{ marginBottom: 20 }}
      />

      {step === 0 && (
        <Form layout="vertical">
          <Form.Item label={t("region")} required>
            <Select
              value={region}
              onChange={setRegion}
              options={regionOpts}
              showSearch
              placeholder={t("请选择 region(账号里启用的区;已有执行环境的区不可选)")}
              notFoundContent={regionSrcErr ? t("读不到账号的 region 清单") : undefined}
              loading={regionLoading}
              style={{ maxWidth: 420 }}
            />
            <Space size={8} style={{ marginTop: 6 }}>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={regionLoading}
                onClick={() => setRegionReload((n) => n + 1)}
                data-testid="wizard-region-refresh"
              >
                {t("刷新")}
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }} data-testid="wizard-region-source">
                {regionQueriedAt
                  ? t("账号已启用 {n} 个 region · 查询于 {at}", {
                      n: regionOpts.length,
                      at: new Date(regionQueriedAt).toLocaleTimeString(),
                    })
                  : ""}
              </Text>
            </Space>
            {regionQueriedAt ? (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }} data-testid="wizard-region-preauth">
                  {t("其中控制面已放行 {n} 个区(建完即可用);其余区构建完成后需运维跑一次放行命令再「检测初始化」", { n: preauthCount })}
                </Text>
              </div>
            ) : null}
            {regionSrcErr ? (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 8 }}
                message={t("读不到账号启用的 region 清单")}
                description={regionSrcErr}
              />
            ) : null}
          </Form.Item>
          {/* 账号输入已按用户拍板(2026-09-01)移除:执行环境严格限定控制面同账号,accountId 服务端自取 */}
          <Form.Item
            label={t("法域标记 jurisdiction")}
            tooltip={t("缺省 home。非 home 法域(如 eu-sim)须装 residency-api(区域审计 / 结果存储)—— 这是技术前置,不是审批;格式小写字母开头、[a-z0-9-]、2–32 位")}
            validateStatus={jurisdictionValid ? undefined : "error"}
            help={jurisdictionValid ? undefined : t("格式非法:小写字母开头、只含 a-z / 0-9 / -,2–32 位(如 home / eu-sim;不收 EU / Home)")}
            // @kf-batch 50-PROD-B-seq33 ④:只提示不拦截(用户 2026-10-10)—— 法域标记不由 region 推导,只能靠人改
            extra={<span data-testid="wizard-jurisdiction-hint">{t("执行区与主控区不在同一法域时,请修改法域标记")}</span>}
          >
            <Input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value.trim() || "home")} style={{ maxWidth: 320 }} />
          </Form.Item>
          <Space size="large">
            <Form.Item label={t("cellId(可选)")}>
              <Input value={cellId} onChange={(e) => setCellId(e.target.value.trim())} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label={t("stage(可选)")}>
              <Input value={stage} onChange={(e) => setStage(e.target.value.trim())} style={{ width: 200 }} />
            </Form.Item>
          </Space>
          {/* @kf-batch 50-WP16-zero-egress:取代原「网络规模」单选 + EIP 配额预检的只读说明 */}
          <Alert
            data-testid="wizard-zero-egress-note"
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("本区执行环境为零出网")}
            description={
              <div style={{ fontSize: 12 }}>
                {t(
                  "不建 NAT 网关、不占用弹性 IP;全部 AWS 调用走 VPC 端点(S3 / DynamoDB 走免费网关端点,其余走接口端点)。跨区只有一条私有链路:回主控区写运行台账。"
                )}
              </div>
            }
          />
          <Alert
            type="info"
            showIcon
            message={t("资源名预览(命名 SSOT)")}
            description={
              <div style={{ fontSize: 12 }}>
                <div style={{ marginBottom: 4 }}>
                  <Text type="secondary">
                    {t("预览按第一候选 id {id} 计算;实际 targetId 由服务端生成(同区已有环境时会顺延)", { id: previewId })}
                  </Text>
                </div>
                {previews.map((p) => (
                  <div key={p.label}>
                    <Text type="secondary">{t(p.label)}:</Text> <Text code>{p.value}</Text>
                  </div>
                ))}
              </div>
            }
          />
          <div style={{ textAlign: "right", marginTop: 16 }}>
            {/* 🔴 没选 region 不许进下一步(第一步的必填项就是它;默认值曾真建出第 5 套环境) */}
            <Button type="primary" disabled={!jurisdictionValid || !region} onClick={() => setStep(1)}>
              {t("下一步")}
            </Button>
          </div>
        </Form>
      )}

      {step === 1 && (
        <div>
          {/* @kf-batch 50-PROD-B-seq33 ②:只读清单 —— 每个执行环境都装齐,没有勾选 */}
          <div data-testid="wizard-components-readonly">
            {COMPONENT_META.filter((c) => required.includes(c.key)).map((c) => (
              <div key={c.key} data-testid={`wizard-component-${c.key}`} style={{ padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                <Space>
                  <Tag color="blue">{t("必装")}</Tag>
                  <Text strong>{c.label}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t(c.desc)} · {c.cost}
                  </Text>
                </Space>
              </div>
            ))}
          </div>
          <Alert
            data-testid="wizard-components-full-note"
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message={t("每个执行环境都装齐全部组件,不提供精简形态")}
            description={t(
              "组件由法域决定:每个区都装 core / redshift / dms / flink / airflow-serverless;法域不是 home 时另装 residency-api。成本口径:Redshift Serverless 按 RPU 用量计费、空闲不计费;DMS 复制实例与 Flink 作业按需;airflow-serverless 按任务运行秒数;零出网,无 NAT 常驻费用"
            )}
          />
          <div style={{ textAlign: "right", marginTop: 16 }}>
            <Space>
              <Button onClick={() => setStep(0)}>{t("上一步")}</Button>
              <Button type="primary" onClick={() => setStep(2)}>
                {t("下一步")}
              </Button>
            </Space>
          </div>
        </div>
      )}

      {step === 2 && !deployed && (
        <div>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="region">{region}</Descriptions.Item>
            <Descriptions.Item label={t("法域")}>{jurisdiction}</Descriptions.Item>
            <Descriptions.Item label={t("组件")}>{required.join(", ")}</Descriptions.Item>
          </Descriptions>
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message={t("点击后平台经 CodeBuild 自动部署(部署权隔离,§12.0),无需手敲命令;向导将原地显示实时进度")}
          />
          {crossJurisdiction && (
            // @kf-batch 50-W5-seg1-WP10a —— 免责告知(INTERACTION v2.17 §4bis.4 时点 ①):文案单作者 disclaimer.ts,
            //    不勾 ⇒〔开始部署〕禁用;勾了 ⇒ 注册请求带 residencyAck,服务端核对版本 / 文本哈希后写进描述符(可回查)。
            <Alert
              style={{ marginTop: 12 }}
              type="warning"
              showIcon
              message={t("免责告知(文案 {v})", { v: DISCLAIMER_VERSION })}
              description={
                <Space direction="vertical" size={6} style={{ width: "100%" }}>
                  <Typography.Text data-testid="residency-disclaimer-text">{DISCLAIMER_TEXT}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("非 home 法域({j})须装 residency-api(区域审计 / 结果存储),这是技术前置;平台不做法务判断,同意记录将保存在该环境的详情页供回查。", { j: jurisdiction })}
                  </Typography.Text>
                  <Checkbox data-testid="residency-disclaimer-ack" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)}>
                    {t("我已阅读并同意")}
                  </Checkbox>
                </Space>
              }
            />
          )}
          <div style={{ textAlign: "right", marginTop: 16 }}>
            <Space>
              <Button onClick={() => setStep(1)}>{t("上一步")}</Button>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={submitting}
                disabled={(crossJurisdiction && !ackChecked)}
                onClick={startDeploy}
              >
                {t("开始部署")}
              </Button>
            </Space>
          </div>
        </div>
      )}

      {step === 2 && deployed && (
        <div>
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("环境 {id} 已创建,部署进行中", { id: deployed.targetId })}
          />
          {regionNotice && (
            <Alert
              type="warning"
              showIcon
              data-testid="region-not-enabled"
              style={{ marginBottom: 12 }}
              message={t("控制面尚未放行该 region:部署可以完成,但「检测初始化」会在放行前失败")}
              description={regionNotice}
            />
          )}
          {/* 显式带 buildId:绕开「首拉 vs broker 回写 lastBuildId」竞态(P50.2e3 实测:竞态输了会
              拿到 phase="none" 被当终态停轮询,进度页永远「当前无构建」) */}
          <BuildProgress targetId={deployed.targetId} buildId={deployed.buildId || undefined} />
          <div style={{ textAlign: "right", marginTop: 16 }}>
            <Button
              type="primary"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              {t("完成(可稍后在详情页继续看进度)")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
