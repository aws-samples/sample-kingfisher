"use client";

// 执行环境管理页(50 INTERACTION §1.1 列表 + §1.2 向导 + §1.3 详情;URL = /exec-envs,
// ACCEPTANCE §6 的 L2 契约锚「/exec-envs 页加载、home 卡片在」)。
//
// 数据全部来自 /api/admin/exec-envs*(网关层已强制 bgp-admin;非管理员整页 403,给友好提示)。
// 卡片字段照 §1.1 线框;绑定任务数/月成本两项的**数据源尚不存在**(绑定统计与成本),
// 如实不显示,不摆两个恒为「—」的假指标。
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Col, Empty, Row, Space, Tag, Tooltip, Typography, message, theme as antdTheme } from "antd";
import { seedHome } from "./api";
import { CloudOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import FeatureGuide from "@/components/common/FeatureGuide";
// 「这个组件装出来了没有」的唯一判断(纯函数,判据钉它)
import { componentViewItems, claimsNothingInstalled } from "@/lib/exec-env/component-view";
import { ApiError, STATUS_META, listTargets, type ExecEnvTarget } from "./api";
import CreateWizard from "./CreateWizard";
import TargetDetail from "./TargetDetail";
import { useBrowserInitialState } from "@/lib/hydration/use-browser-initial-state";

const { Text } = Typography;

export default function ExecEnvsPage() {
  // (用户 2026-09-08:列表页只有主控卡醒目、其他区暗且框更小)
  // 🔴 颜色**只从主题 token 取**,不写死十六进制:全站有 13 款皮肤(lib/skins/skins.ts 是单一事实源),
  //   页面里硬编码 #e0a23c 这种值换肤后必然与整体风格脱节(原来主控卡就是这么写的)。
  //   token 家族由 antd 从各皮肤主色派生 ⇒ 主控 = 警示色系边框、其他区 = 主色系边框,两者同粗同亮度层级。
  const { token } = antdTheme.useToken();
  const t = useT();
  const [targets, setTargets] = useState<ExecEnvTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState<string>("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selected, setSelected] = useState<ExecEnvTarget | null>(null);
  // 深链 `/exec-envs?target=<id>&highlight=<component>`(调度页「去执行环境补装 MWAA」落点):
  //   列表加载后自动打开该 target 的抽屉,并把要补的组件行高亮。只读一次(用户手动关抽屉后不再自动弹回)。
  //   首帧 null(= 服务端),挂载后再读地址栏;初值函数里读 window 会让 React 19 报水合不一致
  const [deepLink, setDeepLink] = useBrowserInitialState<{ target: string; highlight: string } | null>(null, () => {
    const q = new URLSearchParams(window.location.search);
    const target = q.get("target");
    return target ? { target, highlight: q.get("highlight") || "" } : null;
  });
  const [seeding, setSeeding] = useState(false);

  /** home seed(bgp-admin 显式动作;服务端真探全绿才落库,红项会带原因回来)。 */
  const doSeedHome = () => {
    setSeeding(true);
    seedHome()
      .then((r) => {
        message.success(t("home 已初始化(探活 {n} 项全绿)", { n: r.probe.items.length }));
        fetchData();
      })
      .catch((e) => {
        const detail = e instanceof ApiError ? e.detail : undefined;
        const failed = (detail as { probe?: { items?: Array<{ name: string; ok: boolean; error?: string }> } })?.probe?.items?.filter((i) => !i.ok);
        if (failed?.length) {
          message.error(t("home 探活未全绿,未落库:{list}", { list: failed.map((f) => `${f.name}(${f.error ?? "?"})`).join("; ") }), 8);
        } else {
          message.error((e as Error).message);
        }
      })
      .finally(() => setSeeding(false));
  };

  const fetchData = () => {
    setLoading(true);
    listTargets()
      .then((rows) => {
        setTargets(rows);
        setDenied("");
        if (deepLink) {
          const hit = rows.find((r) => r.targetId === deepLink.target);
          if (hit) setSelected(hit);
          setDeepLink((cur) => (cur ? { ...cur, target: "" } : cur)); // 只自动打开一次;highlight 保留给抽屉
        }
        // 详情抽屉开着时同步刷新它的数据(状态可能被 probe/enable 改了)
        setSelected((cur) => (cur ? rows.find((r) => r.targetId === cur.targetId) ?? cur : cur));
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setDenied(e.message);
        else message.error((e as Error).message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, []);

  const hasHome = targets.some((x) => x.isHome === true || x.targetId === "tgt_home");

  // home 卡置顶(机制D:主控一眼可辨),其余按 targetId 稳定排序。
  const sorted = useMemo(() => {
    const isHome = (x: ExecEnvTarget) => x.isHome === true || x.targetId === "tgt_home";
    return [...targets].sort((a, b) => Number(isHome(b)) - Number(isHome(a)) || a.targetId.localeCompare(b.targetId));
  }, [targets]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <Space>
          <CloudOutlined style={{ fontSize: 20 }} />
          <h2 style={{ margin: 0 }}>{t("执行环境")}</h2>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
            {t("刷新")}
          </Button>
          <Button type="primary" data-testid="exec-env-new-btn" icon={<PlusOutlined />} onClick={() => setWizardOpen(true)} disabled={!!denied}>
            {t("新建执行环境")}
          </Button>
          {!loading && !denied && targets.length > 0 && !hasHome && (
            <Button loading={seeding} onClick={doSeedHome}>{t("初始化 home 环境")}</Button>
          )}
        </Space>
      </div>

      <FeatureGuide
        title={t("执行环境")}
        what="管理多个 region 的执行环境:注册 → 平台自动部署(CodeBuild 隔离部署权)→ 探活 → 启用后接受任务下推。"
        steps={[
          "点「新建执行环境」选 region 与组件,平台一键自动部署并实时显示逐栈进度",
          "部署完成后在详情页「检测初始化」逐资源探活,全绿后「启用」",
          "任务/调度即可绑定到该环境执行(数据不出该 region)",
        ]}
        tips={[
          "🏠 主控(home)环境不可删除;当前阶段新环境仅支持 core 组件,数仓/调度等可事后补充部署",
          "删除环境走审批流且数据桶一律保留(RETAIN),不随销毁删除",
        ]}
      />

      {denied ? (
        <Alert type="warning" showIcon message={t("无权访问")} description={denied} style={{ marginBottom: 12 }} />
      ) : null}

      {sorted.length === 0 && !loading && !denied ? (
        <Empty description={t("暂无执行环境记录 —— home(当前环境)的描述符还没 seed 进注册表")}>
          <Button type="primary" loading={seeding} onClick={doSeedHome}>{t("初始化 home 环境")}</Button>
        </Empty>
      ) : (
        <Row gutter={[12, 12]}>
          {sorted.map((x) => {
            const meta = STATUS_META[x.status] ?? { color: "default", label: x.status };
            const home = x.isHome === true || x.targetId === "tgt_home";
            return (
              // 🔴 卡片**等高**:Col 变 flex 容器 + Card 撑满,body 给 minHeight ——
              //   否则组件 tag 少的区域卡片明显矮一截(主控装的组件最多,看起来"框大很多")。
              <Col key={x.targetId} xs={24} sm={12} lg={8} xxl={6} style={{ display: "flex" }}>
                <Card
                  size="small"
                  hoverable
                  onClick={() => setSelected(x)}
                  style={{
                    width: "100%",
                    height: "100%",
                    // 主控 = 警示色、其他区 = 主色,**两者同等醒目**(1px 实线 + 一圈同色微光)。
                    // 🔴 用 `colorPrimaryBorder` / `colorWarningBorder` 那一档太淡(用户实测:「线框很淡,不明显」)⇒
                    //   改用 `colorPrimary` / `colorWarning` 本色;微光用 8 位十六进制透明度,随皮肤一起变。
                    borderColor: home ? token.colorWarning : token.colorPrimary,
                    boxShadow: `0 0 0 1px ${home ? token.colorWarning : token.colorPrimary}40, 0 0 12px -4px ${home ? token.colorWarning : token.colorPrimary}`,
                  }}
                  styles={{ body: { minHeight: 116 } }}
                  title={
                    <Space>
                      {home ? <span>🏠</span> : null}
                      <Text strong>{x.region}</Text>
                      {home ? <Tag color="gold">{t("主控")}</Tag> : null}
                    </Space>
                  }
                  extra={
                    <Space size={4}>
                      {/* 🔴 徽标(生命周期×健康的投影)**看不出**新鲜度与残留锁 ⇒ 会出现"写着运行中、
                          数据面其实一律拒收"。这里在**已知不可承接**时打一个红 tag,原因挂 Tooltip;
                          字段缺失(旧后端)刻意什么都不打 —— 不知道就别装作知道,详情抽屉里会写明"未知"。 */}
                      {x.serviceability?.usable === false ? (
                        <Tooltip title={x.serviceability.reason ?? ""}>
                          <Tag color="error" style={{ marginInlineEnd: 0 }}>
                            {t("不承接新工作")}
                          </Tag>
                        </Tooltip>
                      ) : null}
                      <Badge status={meta.color as never} text={t(meta.label)} />
                    </Space>
                  }
                >
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    <Text code style={{ fontSize: 12 }}>
                      {x.targetId}
                    </Text>
                    {/*
                      🔴🔴 **期望态 ≠ 观测态**(双轴,SPEC §1.1)。
                      改动前这里渲染的是顶层 `components` —— 那是**注册那一刻按用户勾选写进去的期望态**,
                      于是 `registered`(还没部署)的环境在卡片上**看起来已经装好了**。
                      真环境实测(2026-09-20,用户从页面复制给我的那三行之一):
                        tgt_euw1_a  status=registered  components=['core','redshift']
                                    observed={}  resources 键数=0  probe.ok=False
                      ⇒ 界面宣称了**两个根本没有载体的组件**(与那条「界面宣称了没有载体的能力」同族)。
                      🔴 双轴数据**早就在描述符里**(`observed.components`),只是呈现面这条路没接 ——
                        本仓第 N 次「机制建好了,某条路径没接上」。
                      🔴 刻意 **fail-closed**:`observed.components` 里没有的就**不算已装**,不回落到期望态。
                        真值支持这么做(两个装好的区 observed.components 都齐,且与 spec 逐项一致);
                        回落才是危险的 —— 那等于「读不到就当它装好了」。
                    */}
                    <div>
                      {componentViewItems(x).map(({ name, installed }) => (
                        <Tag
                          key={name}
                          data-testid={installed ? `comp-installed-${name}` : `comp-pending-${name}`}
                          style={{
                            marginBottom: 2,
                            ...(installed ? {} : { borderStyle: "dashed", opacity: 0.6 }),
                          }}
                        >
                          {name}
                          {installed ? "" : ` · ${t("待部署")}`}
                        </Tag>
                      ))}
                      {componentViewItems(x).length === 0 ? (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t("(组件未记录)")}
                        </Text>
                      ) : null}
                      {claimsNothingInstalled(x) ? (
                        <div data-testid="comp-none-installed">
                          <Text type="warning" style={{ fontSize: 12 }}>
                            {t("尚未部署:上面是这个环境声称要装的组件,一个都还没建出来")}
                          </Text>
                        </div>
                      ) : null}
                    </div>
                    <Space size={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t("法域")} {x.jurisdiction ?? "home"}
                      </Text>
                      <Tooltip title={t("最近探活时间(探活写入方随切片 e 交付)")}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {x.probe?.at ? t("探活 {at}", { at: x.probe.at.slice(5, 16).replace("T", " ") }) : t("未探活")}
                        </Text>
                      </Tooltip>
                    </Space>
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      <CreateWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onCreated={fetchData} />
      <TargetDetail target={selected} onClose={() => setSelected(null)} onChanged={fetchData} highlightComponent={deepLink?.highlight || undefined} />
    </div>
  );
}
