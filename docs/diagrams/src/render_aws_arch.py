#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 AWS 官方架构图标(Architecture Icons 2026-07-31,src/aws-icons/)渲染 Kingfisher 的四张架构图(静态 PNG,白底):
  aws-overview.png          单控制面 × N 执行面 总览
  aws-control-plane.png     主控区控制面(23 个 CDK 栈分层)
  aws-execution-region.png  执行区数据面(每区一套 BgpExecEnv-<slug>-* 栈组)
  aws-multi-region.png      多区域机制:执行范围 / 落点 / 禁止跨区取数 / 每区自治调度
只含服务级信息,不含账号 / 资源 ID / URL。重渲:python3 docs/diagrams/src/render_aws_arch.py
依赖:Pillow + Noto Sans CJK(/usr/share/fonts/google-noto-cjk)。"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "aws-icons")
OUT = os.path.dirname(HERE)
FONT_DIR = "/usr/share/fonts/google-noto-cjk"
FONTS = {False: os.path.join(FONT_DIR, "NotoSansCJK-Regular.ttc"), True: os.path.join(FONT_DIR, "NotoSansCJK-Bold.ttc")}
_FC = {}
def F(size, bold=False):
    k = (size, bold)
    if k not in _FC:
        _FC[k] = ImageFont.truetype(FONTS[bold], size)
    return _FC[k]

INK, GRAY, LIGHT = (35, 47, 62), (84, 91, 100), (213, 219, 219)
BG, PANEL, PANEL2 = (255, 255, 255), (247, 248, 250), (238, 241, 245)
PURPLE, PURPLE_L = (90, 48, 181), (236, 230, 250)
BLUE, BLUE_L = (0, 115, 187), (227, 240, 250)
ORANGE, ORANGE_L = (236, 114, 17), (255, 240, 224)
GREEN = (29, 129, 2)
WHITE = (255, 255, 255)

class Canvas:
    def __init__(self, w, h):
        self.im = Image.new("RGB", (w, h), BG)
        self.d = ImageDraw.Draw(self.im)
        self.w, self.h = w, h
    def text(self, x, y, s, size=20, color=INK, bold=False, anchor="la", maxw=None):
        f = F(size, bold)
        if maxw:
            for line in wrap(s, f, maxw):
                self.d.text((x, y), line, font=f, fill=color, anchor=anchor)
                y += int(size * 1.45)
            return y
        self.d.text((x, y), s, font=f, fill=color, anchor=anchor)
        return y + int(size * 1.45)
    def tw(self, s, size, bold=False):
        return self.d.textlength(s, font=F(size, bold))
    def panel(self, x, y, w, h, fill=PANEL, outline=LIGHT, width=2, radius=16):
        self.d.rounded_rectangle((x, y, x + w, y + h), radius=radius, fill=fill, outline=outline, width=width)
    def pill(self, x, y, s, fill, color=WHITE, size=17, bold=True, padx=18, h=36):
        w = int(self.tw(s, size, bold)) + padx * 2
        self.d.rounded_rectangle((x, y, x + w, y + h), radius=h // 2, fill=fill)
        self.d.text((x + w / 2, y + h / 2), s, font=F(size, bold), fill=color, anchor="mm")
        return w
    def icon(self, cx, top, name, label, sub=None, size=80, lsize=19, ssize=15, lw=190):
        im = Image.open(os.path.join(ICONS, name)).convert("RGBA")
        if name.startswith("Res_"):  # 资源类图标是白色线稿(深色主题用),白底上着成墨色
            tinted = Image.new("RGBA", im.size, INK + (255,)); tinted.putalpha(im.getchannel("A")); im = tinted
        if im.size[0] != size:
            im = im.resize((size, size), Image.LANCZOS)
        self.im.paste(im, (int(cx - size / 2), int(top)), im)
        y = top + size + 8
        if label is None:
            return y
        self.d.text((cx, y), label, font=F(lsize, True), fill=INK, anchor="ma")
        y += int(lsize * 1.35)
        if sub:
            for line in wrap(sub, F(ssize), lw):
                self.d.text((cx, y), line, font=F(ssize), fill=GRAY, anchor="ma")
                y += int(ssize * 1.35)
        return y
    def arrow(self, p1, p2, color=INK, width=4, head=16, dashed=False):
        (x1, y1), (x2, y2) = p1, p2
        if dashed:
            dx, dy = x2 - x1, y2 - y1
            L = max(1.0, (dx * dx + dy * dy) ** 0.5)
            n = int(L // 18)
            for i in range(0, n, 2):
                a = (x1 + dx * i / n, y1 + dy * i / n); b = (x1 + dx * (i + 1) / n, y1 + dy * (i + 1) / n)
                self.d.line([a, b], fill=color, width=width)
        else:
            self.d.line([p1, p2], fill=color, width=width)
        dx, dy = x2 - x1, y2 - y1
        L = max(1.0, (dx * dx + dy * dy) ** 0.5); ux, uy = dx / L, dy / L
        px, py = -uy, ux
        tip = (x2, y2); b1 = (x2 - ux * head + px * head * 0.55, y2 - uy * head + py * head * 0.55)
        b2 = (x2 - ux * head - px * head * 0.55, y2 - uy * head - py * head * 0.55)
        self.d.polygon([tip, b1, b2], fill=color)
    def title(self, s, sub=None, tag=None):
        x = 70
        if tag:
            self.d.rounded_rectangle((x, 52, x + 10, 118), radius=4, fill=BLUE); x += 30
        self.d.text((x, 50), s, font=F(40, True), fill=INK)
        if sub:
            self.d.text((x, 108), sub, font=F(20), fill=GRAY)
        self.d.line([(70, 150), (self.w - 70, 150)], fill=LIGHT, width=2)
    def footer(self, s):
        self.d.text((70, self.h - 46), s, font=F(15), fill=GRAY)
    def save(self, name):
        p = os.path.join(OUT, name); self.im.save(p, optimize=True); print("wrote", p, self.im.size)

def wrap(s, font, maxw):
    """按像素宽折行(中英文混排,按字符累加)。"""
    lines, cur = [], ""
    for ch in s:
        if ch == "\n":
            lines.append(cur); cur = ""; continue
        if font.getlength(cur + ch) > maxw and cur:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur: lines.append(cur)
    return lines

def grid_icons(c, items, x, y, w, cols, rowh=175, size=80, lw=None):
    cw = w / cols
    for i, (ic, lb, sb) in enumerate(items):
        r, col = divmod(i, cols)
        c.icon(x + cw * (col + 0.5), y + r * rowh, ic, lb, sb, size=size, lw=lw or int(cw - 16))
    rows = (len(items) + cols - 1) // cols
    return y + rows * rowh

# ──────────────────────────── 1. 总览 ────────────────────────────
def overview():
    c = Canvas(2000, 1230)
    c.title("Kingfisher 技术架构:单控制面 × N 执行面(单 AWS 账号 · 多区域 · 全托管服务)",
            "一个主控区放控制面(页面 / 元数据 / 智能体),N 个执行区各自一套数据面(数仓 / 湖 / 计算 / 调度 / 实时),数据不出本区", tag=True)
    # 入口链
    y0 = 185
    chain = [("Res_Users_48_Dark.png", "用户 / 浏览器", "中文 / 英文界面"), ("Arch_Amazon-CloudFront_64.png", "CloudFront", "唯一公网入口"),
             ("Arch_AWS-WAF_64.png", "WAF", "WebACL · 限速"), ("Arch_Elastic-Load-Balancing_64.png", "ALB", "仅放行 CloudFront 前缀"),
             ("Arch_Amazon-Elastic-Container-Service_64.png", "ECS Fargate", "Next.js 全栈 · API 即 BFF"), ("Arch_Amazon-Cognito_64.png", "Cognito", "每个 /api/* 校验 ID token")]
    xs = [150, 380, 610, 840, 1070, 1300]
    for (ic, lb, sb), x in zip(chain, xs):
        c.icon(x, y0, ic, lb, sb, lw=200)
        if x != xs[-1]:
            c.arrow((x + 52, y0 + 40), (x + 230 - 52, y0 + 40), color=ORANGE, width=5)
    c.panel(1470, y0 - 10, 460, 160, fill=ORANGE_L, outline=ORANGE)
    c.text(1495, y0 + 6, "安全边界", 20, ORANGE, True)
    c.text(1495, y0 + 40, "资源级 RBAC(项目空间 owner / editor / viewer)· 审批流 · 全部写操作进审计 · 后端全在私有子网 · TaskRole 直调 AWS API 不落长期密钥 · KMS CMK 加密", 15, GRAY, maxw=415)
    # 控制面
    L, T, PW, PH = 70, 380, 880, 560
    c.panel(L, T, PW, PH, fill=PANEL, outline=PURPLE, width=3)
    c.text(L + 24, T + 16, "控制面 · 主控区(客户安装时指定)· 全平台唯一,不复制", 24, PURPLE, True)
    c.text(L + 24, T + 54, "身份 · 台账 · 目录 · 业务口径 · AI 大脑 · 审批 / 审计 · 执行环境部署 broker", 17, GRAY)
    ctrl = [("Arch_Amazon-Cognito_64.png", "Cognito", "身份 · 项目 RBAC"), ("Arch_Amazon-DynamoDB_64.png", "DynamoDB", "72 张控制表 · 运行台账"),
            ("Arch_AWS-Secrets-Manager_64.png", "Secrets Manager", "凭证 · 无硬编码"), ("Arch_AWS-Key-Management-Service_64.png", "KMS", "CMK 加密"),
            ("Arch_AWS-CodeBuild_64.png", "CodeBuild", "执行环境部署 broker"),
            ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", "ECS · 治理事实源"), ("Arch_Amazon-RDS_64.png", "RDS MySQL", "OM 元数据库"),
            ("Arch_Amazon-OpenSearch-Service_64.png", "OpenSearch", "OM 检索"), ("Arch_Amazon-Bedrock_64.png", "Bedrock", "Claude / GPT / GLM / Kimi 四系列"),
            ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore", "问数 · 网络顾问 · 参数顾问")]
    grid_icons(c, ctrl, L + 20, T + 100, PW - 40, 5, rowh=200)
    c.text(L + 24, T + PH - 40, "+ CloudWatch / CloudTrail 可观测与审计 · AWS DevOps Agent 运行诊断 · 全部 CDK 部署(23 栈)", 16, GRAY)
    # 执行面
    L2, PW2 = 990, 940
    c.panel(L2, T, PW2, PH, fill=PANEL, outline=BLUE, width=3)
    c.text(L2 + 24, T + 16, "执行面 · 每个区域一套(tgt_*)· 数据与调度不出区", 24, BLUE, True)
    c.text(L2 + 24, T + 54, "算力 · 存储 · 调度 · 网络 · IAM 全按区域复制;页面向导注册即由 CodeBuild 用 CDK 建出", 17, GRAY)
    exe = [("Arch_Amazon-Virtual-Private-Cloud_64.png", "VPC", "零出网 · 仅接口端点"), ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 / S3 Tables", "数据湖 · Iceberg"),
           ("Arch_AWS-Glue_64.png", "Glue", "批同步 · PySpark"), ("Arch_Amazon-EMR_64.png", "EMR Serverless", "Spark 计算"),
           ("Arch_Amazon-Athena_64.png", "Athena", "数据湖直查"), ("Arch_Amazon-Redshift_64.png", "Redshift Serverless", "数仓 · Data API"),
           ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA Serverless", "区内自治调度"), ("Arch_AWS-Database-Migration-Service_64.png", "DMS", "实时 CDC"),
           ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "Managed Flink", "实时计算"), ("Arch_Amazon-Managed-Streaming-for-Apache-Kafka_64.png", "MSK", "流数据源"),
           ("Arch_AWS-Identity-and-Access-Management_64.png", "IAM", "每区执行角色 · 锁区"), ("Arch_AWS-CloudFormation_64.png", "CloudFormation", "每区一组栈")]
    grid_icons(c, exe, L2 + 20, T + 100, PW2 - 40, 6, rowh=200)
    px = L2 + 24; py = T + PH - 48
    for lb, col in (("主控区 · tgt_home(控制面所在区,也有一套数据面)", PURPLE), ("执行区 1 · tgt_<slug>", BLUE), ("… 执行区 N", (120, 130, 140))):
        px += c.pill(px, py, lb, col, size=16) + 14
    # 底部连接带
    c.panel(70, 975, 1860, 150, fill=PANEL2, outline=LIGHT)
    c.arrow((400, 1015), (520, 1015), color=PURPLE, width=5)
    c.text(90, 1000, "控制面 → 执行面", 20, PURPLE, True)
    c.text(540, 1003, "下发任务定义 · CodeBuild 部署栈组 · 探活 / 组件补装 · IAM 按 aws:RequestedRegion 只放行已启用的区", 17, GRAY)
    c.arrow((520, 1060), (400, 1060), color=BLUE, width=5, dashed=True)
    c.text(90, 1045, "执行面 → 控制面", 20, BLUE, True)
    c.text(540, 1048, "只回写运行元数据(唯一跨区调用):跨区 VPC peering + 主控区侧同区接口端点 + 私有托管域,应用代码零改动", 17, GRAY)
    c.text(90, 1090, "数据不跨区域", 20, INK, True)
    c.text(540, 1093, "平台不做任何跨区复制;每个区的数仓、湖、日志、DAG、审计原文都留在本区 —— 满足数据驻留 / 法域要求", 17, GRAY)
    c.footer("Kingfisher · 大数据治理与开发平台 · 架构图只含服务级信息,不含账号 / 资源 ID / URL · 源:docs/diagrams/src/render_aws_arch.py")
    c.save("aws-overview.png")

# ──────────────────────────── 2. 控制面 ────────────────────────────
def control_plane():
    c = Canvas(2000, 1400)
    c.title("主控区控制面:23 个 CDK 栈分六层(17 个常驻 + 6 个按 context 门控)",
            "入口 infra/bin/app.ts;栈名前缀 Bgp*;接线事实写 SSM /bgp/wiring/*,synth 时自动读回", tag=True)
    layers = [
        ("边缘与应用层", ORANGE, [
            ("Arch_Amazon-CloudFront_64.png", "CloudFront", "唯一公网入口"), ("Arch_AWS-WAF_64.png", "WAF", "固定 us-east-1 · WebACL"),
            ("Arch_Elastic-Load-Balancing_64.png", "ALB", "仅放行 CloudFront 前缀"), ("Arch_Amazon-Elastic-Container-Service_64.png", "ECS Fargate 平台", "Next.js · 40 页面 · 309 API"),
            ("Arch_Amazon-Cognito_64.png", "Cognito", "用户池 · 每个 /api/* 校验")],
         "BgpWafStack · BgpPlatformStack(ECS + TaskRole + ALB + CloudFront)· BgpAuthStack"),
        ("状态 · 身份 · 网络", PURPLE, [
            ("Arch_Amazon-DynamoDB_64.png", "DynamoDB 72 表", "注册表 · 运行台账 · 长操作租约"), ("Arch_AWS-Secrets-Manager_64.png", "Secrets Manager", "数据源 / 数仓凭证"),
            ("Arch_AWS-Key-Management-Service_64.png", "KMS", "CMK · 全部静态加密"), ("Arch_Amazon-Virtual-Private-Cloud_64.png", "VPC", "私有子网 · 接口端点"),
            ("Arch_AWS-Identity-and-Access-Management_64.png", "IAM", "TaskRole 127 条真实调用清单")],
         "BgpDatabaseStack(67 表)· BgpFinOpsStack(3 表)· BgpKmsStack · BgpVpcStack"),
        ("元数据与智能体", GREEN, [
            ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", "ECS · 目录 / 血缘 / 质量事实源"), ("Arch_Amazon-RDS_64.png", "RDS MySQL", "OM 元数据库"),
            ("Arch_Amazon-OpenSearch-Service_64.png", "OpenSearch", "OM 检索"), ("Arch_Amazon-Bedrock_64.png", "Bedrock", "Claude Opus / GPT / GLM / Kimi"),
            ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore × 3", "问数 genbi · 网络顾问 · 参数顾问"), ("Arch_AWS-DevOps-Agent_64.png", "DevOps Agent", "运行失败 AI 诊断")],
         "BgpOmDatabaseStack · BgpOmSearchStack · BgpOmServiceStack · BgpAgentCoreStack · BgpNetAdvisorAgentCoreStack · BgpParamAdvisorAgentCoreStack · BgpOmIngestionStack(门控)"),
        ("执行环境部署机制", BLUE, [
            ("Arch_AWS-Lambda_64.png", "broker Lambda", "独家 StartBuild"), ("Arch_AWS-CodeBuild_64.png", "CodeBuild", "在目标区 bootstrap + cdk deploy"),
            ("Arch_AWS-CloudFormation_64.png", "CloudFormation", "BgpExecEnv-<slug>-* 栈组"), ("Arch_AWS-Lambda_64.png", "action-dispatcher", "调度器回调平台动作"),
            ("Arch_AWS-Lambda_64.png", "xregion-peering", "跨区私网回写通道")],
         "BgpExecEnvDeployStack(平台 TaskRole 不持 StartBuild;页面「新建执行环境」是唯一入口)"),
        ("主控区数据面(与执行区同构)", BLUE, [
            ("Arch_Amazon-Redshift_64.png", "Redshift Serverless", "主控区数仓"), ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA Serverless", "主控区调度"),
            ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 / S3 Tables", "数据湖 · 脚本桶"), ("Arch_AWS-Glue_64.png", "Glue", "同步 / 发现作业"),
            ("Arch_Amazon-EMR_64.png", "EMR Serverless", "门控 -c enable-emr"), ("Arch_AWS-Database-Migration-Service_64.png", "DMS", "门控 -c enable-realtime"),
            ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "MSAF Flink", "门控 -c enable-flink")],
         "BgpRedshiftStack · BgpAirflowServerlessStack · BgpRealtimeStack / BgpFlinkStack / BgpEmrStack(门控)· BgpRdsStack(仅 demo 演示源库)· BgpMwaaStack(经典,门控)"),
        ("可观测与审计", GRAY, [
            ("Arch_Amazon-CloudWatch_64.png", "CloudWatch", "平台 / 作业日志 · 指标"), ("Arch_AWS-CloudTrail_64.png", "CloudTrail", "AWS 调用审计"),
            ("Arch_Amazon-DynamoDB_64.png", "bgp-audit", "全部写操作 · 非 home 法域双份")],
         "BgpAuditStack · 平台审计表(页面「审计日志」)"),
    ]
    y = 175
    for name, col, items, stacks in layers:
        h = 190
        c.panel(70, y, 1860, h, fill=PANEL, outline=col, width=3)
        c.d.rounded_rectangle((70, y, 300, y + h), radius=16, fill=col)
        c.d.rectangle((285, y, 300, y + h), fill=col)
        for i, line in enumerate(wrap(name, F(24, True), 200)):
            c.d.text((185, y + h / 2 - 30 + i * 36), line, font=F(24, True), fill=WHITE, anchor="mm")
        n = len(items); cw = 1540 / max(n, 5)
        for i, (ic, lb, sb) in enumerate(items):
            c.icon(330 + cw * (i + 0.5), y + 14, ic, lb, sb, size=72, lsize=18, ssize=14, lw=int(cw - 12))
        c.text(330, y + h - 28, stacks, 14, GRAY)
        y += h + 2
    c.footer("Kingfisher · 控制面栈清单以 infra/bin/app.ts 为准 · 图只含服务级信息 · 源:docs/diagrams/src/render_aws_arch.py")
    c.save("aws-control-plane.png")

# ──────────────────────────── 3. 执行区数据面 ────────────────────────────
def execution_region():
    c = Canvas(2000, 1260)
    c.title("执行区数据面:每个区域一套完整栈组 BgpExecEnv-<slug>-*(组件不可裁剪,一区一套)",
            "由页面「系统管理 → 执行环境 → 新建」向导经 CodeBuild 用 CDK 建出;零出网 VPC,AWS 调用全走接口端点;数据不出本区", tag=True)
    # 区域大框
    RX, RY, RW, RH = 70, 175, 1340, 900
    c.panel(RX, RY, RW, RH, fill=BG, outline=BLUE, width=3, radius=22)
    c.pill(RX + 24, RY - 18, "AWS Region · 执行区(例:tgt_<slug>)", BLUE, size=18)
    # VPC 框
    VX, VY, VW, VH = RX + 30, RY + 50, RW - 60, 520
    c.panel(VX, VY, VW, VH, fill=PANEL, outline=(120, 130, 140), width=2, radius=18)
    c.icon(VX + 50, VY + 16, "Arch_Amazon-Virtual-Private-Cloud_64.png", None, size=56)
    c.text(VX + 100, VY + 18, "VPC(-base 栈)", 19, INK, True)
    c.text(VX + 100, VY + 48, "私有子网 · 无 NAT / EIP / IGW · AWS 调用全走 VPC 接口端点(PrivateLink)· KMS CMK alias/bgp-data · alias/bgp-logs", 15, GRAY, maxw=VW - 130)
    # 三列:计算 / 存储 / 调度与实时
    colw = (VW - 60) / 3
    cols = [
        ("计算与查询(-core / -redshift 栈)", [
            ("Arch_AWS-Glue_64.png", "AWS Glue", "批同步 · 发现作业 · PySpark"), ("Arch_Amazon-EMR_64.png", "EMR Serverless", "Spark 离线计算"),
            ("Arch_Amazon-Athena_64.png", "Athena", "数据湖直查 · 联邦目录"), ("Arch_Amazon-Redshift_64.png", "Redshift Serverless", "本区数仓 · Data API")]),
        ("存储(-base 栈 · 数据类资源下线保留)", [
            ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 数据湖桶", "原始 / 脚本 / 产物"), ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 Tables 表桶", "Iceberg · s3tablescatalog"),
            ("Arch_AWS-Key-Management-Service_64.png", "KMS CMK", "本区密钥"), ("Arch_AWS-Secrets-Manager_64.png", "Secrets Manager", "每项目每区数仓凭证")]),
        ("调度与实时(-airflow-serverless / -dms / -flink 栈)", [
            ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA Serverless", "区内自治调度 · DAG 桶"), ("Arch_AWS-Database-Migration-Service_64.png", "DMS", "复制实例 · CDC 任务"),
            ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "Managed Flink", "SQL 运行器 · 写 S3 Tables"), ("Arch_Amazon-Managed-Streaming-for-Apache-Kafka_64.png", "MSK", "流数据源(只读)")]),
    ]
    for i, (hd, items) in enumerate(cols):
        x = VX + 20 + colw * i + 10 * i
        c.panel(x, VY + 95, colw, VH - 115, fill=BG, outline=LIGHT)
        c.text(x + 16, VY + 105, hd, 17, BLUE, True, maxw=colw - 30)
        grid_icons(c, items, x + 8, VY + 150, colw - 16, 2, rowh=165, size=68, lw=int(colw / 2 - 20))
    # VPC 下方:IAM / CFN / residency
    y2 = VY + VH + 20
    row = [("Arch_AWS-Identity-and-Access-Management_64.png", "IAM(-core 栈)", "本区执行角色 · 平台数据面角色 · aws:RequestedRegion 锁本区"),
           ("Arch_AWS-CloudFormation_64.png", "CloudFormation", "base · core · redshift · dms · flink · airflow-serverless(· residency-api)"),
           ("Arch_AWS-Lambda_64.png", "residency-api", "非 home 法域才装:驻留接口 · 双份审计"),
           ("Arch_Amazon-CloudWatch_64.png", "CloudWatch", "作业 / 调度 / 实时日志留在本区")]
    cw = (RW - 60) / 4
    for i, (ic, lb, sb) in enumerate(row):
        c.icon(RX + 30 + cw * (i + 0.5), y2, ic, lb, sb, size=68, lsize=17, ssize=14, lw=int(cw - 24))
    c.text(RX + 30, RY + RH - 70, "本区承接:数据源 · 同步任务 · 离线作业 · 编排工作流 · 直查 · 实时任务 · 治理质量 / 敏感扫描 · 建模落地 · 问数取数 —— 页面顶栏「执行范围」切到该区即见该区对象", 16, GRAY, maxw=RW - 60)
    # 右侧:主控区回写
    HX, HY, HW, HH = 1560, 175, 370, 900
    c.panel(HX, HY, HW, HH, fill=PURPLE_L, outline=PURPLE, width=3, radius=22)
    c.pill(HX + 24, HY - 18, "主控区 · 控制面", PURPLE, size=18)
    items = [("Arch_Amazon-Elastic-Container-Service_64.png", "平台(ECS)", "页面 / API"), ("Arch_Amazon-DynamoDB_64.png", "DynamoDB", "运行台账 · 注册表"),
             ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", "按区 service"), ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore", "落点随调用下发")]
    grid_icons(c, items, HX + 10, HY + 60, HW - 20, 2, rowh=175, size=68, lw=170)
    c.text(HX + 24, HY + 430, "全平台只有一套控制面;「哪个区」是对象上的落点(targetId)与 OpenMetadata 的 service 维度,不是第二套系统。", 15, GRAY, maxw=HW - 48)
    # 箭头
    gx = RX + RW; gw = HX - gx
    c.arrow((HX, 560), (gx, 560), color=PURPLE, width=5)
    c.d.text((gx + gw / 2, 520), "下发定义", font=F(15, True), fill=PURPLE, anchor="mm")
    c.d.text((gx + gw / 2, 540), "部署 · 探活", font=F(15, True), fill=PURPLE, anchor="mm")
    c.arrow((gx, 660), (HX, 660), color=BLUE, width=5, dashed=True)
    c.d.text((gx + gw / 2, 684), "只回写", font=F(15, True), fill=BLUE, anchor="mm")
    c.d.text((gx + gw / 2, 704), "运行元数据", font=F(15, True), fill=BLUE, anchor="mm")
    c.text(RX + 30, RY + RH - 110, "紫色实线 = 控制面 → 本区(下发任务定义 · CodeBuild 部署栈组 · 探活 / 组件补装);蓝色虚线 = 本区 → 控制面(只回写运行元数据,走跨区 VPC peering 私网,唯一跨区调用)", 15, GRAY, maxw=RW - 60)
    c.panel(70, 1100, 1860, 90, fill=PANEL2, outline=LIGHT)
    c.text(90, 1112, "生命周期(页面驱动)", 18, INK, True)
    c.text(90, 1146, "注册 → CodeBuild 部署 → 控制面放行(安装 / 升级时 EXEC_REGION_CANDIDATES 预授权则免)→ 检测初始化 → 启用 → 停止承接 → 审批删除(数据湖桶 / 表桶 / 最终快照 / CMK 保留)", 15, GRAY)
    c.footer("Kingfisher · 执行环境栈组以 infra/lib/exec-env/stack-group.ts 为准 · 图只含服务级信息 · 源:docs/diagrams/src/render_aws_arch.py")
    c.save("aws-execution-region.png")

# ──────────────────────────── 4. 多区域机制 ────────────────────────────
def multi_region():
    c = Canvas(2000, 1300)
    c.title("多区域是怎么做到的:一个控制面 · N 个执行区 · 四条机制 · 一个原则",
            "页面顶栏「执行范围」切区;每个对象 / 每次运行都带落点;跨区取数一律拒绝;每区自己的调度器", tag=True)
    # 顶部:浏览器 + scope
    c.icon(170, 180, "Res_Users_48_Dark.png", "用户", "页面顶栏「执行范围」", size=64, lsize=17, ssize=14, lw=180)
    c.panel(300, 185, 1630, 70, fill=PANEL, outline=LIGHT)
    c.text(325, 203, "执行范围:", 20, INK, True)
    px = 450
    for lb, col in (("全部区(只读汇总)", (120, 130, 140)), ("主控区 · tgt_home", PURPLE), ("执行区 A · tgt_<slug-a>", BLUE), ("执行区 B · tgt_<slug-b>", BLUE), ("… 第 N 区", (120, 130, 140))):
        px += c.pill(px, 202, lb, col, size=16) + 16
    c.text(px + 10, 208, "URL ?scope= 是权威表达;非法 400 · 不存在 404 · 不可见 403 · 未就绪 409,绝不静默回落主控区", 14, GRAY, maxw=1930 - px - 20)
    # 控制面
    CX, CY, CW, CH = 70, 300, 1860, 170
    c.panel(CX, CY, CW, CH, fill=PURPLE_L, outline=PURPLE, width=3)
    c.text(CX + 24, CY + 14, "控制面(主控区)· 全平台唯一", 22, PURPLE, True)
    c.text(CX + 24, CY + 56, "页面 · 72 张控制表 · 身份 · 治理事实源 · 智能体 · 部署 broker;不复制到任何执行区", 15, GRAY, maxw=440)
    items = [("Arch_Amazon-Elastic-Container-Service_64.png", "平台 ECS", None), ("Arch_Amazon-Cognito_64.png", "Cognito", None), ("Arch_Amazon-DynamoDB_64.png", "DynamoDB", None),
             ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", None), ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore", None), ("Arch_AWS-CodeBuild_64.png", "CodeBuild", None)]
    grid_icons(c, items, CX + 560, CY + 40, 1200, 6, rowh=110, size=56, lw=130)
    # 三个区
    regions = [("主控区 · tgt_home(控制面所在区)", PURPLE, PURPLE_L), ("执行区 A · tgt_<slug-a>(例:另一国家 / 法域)", BLUE, BLUE_L), ("执行区 N · tgt_<slug-n>", BLUE, BLUE_L)]
    rw, rh, gap = 590, 400, 45
    y = 560
    mini = [("Arch_Amazon-Redshift_64.png", "Redshift"), ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 Tables"), ("Arch_AWS-Glue_64.png", "Glue"),
            ("Arch_Amazon-EMR_64.png", "EMR"), ("Arch_Amazon-Athena_64.png", "Athena"), ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA"),
            ("Arch_AWS-Database-Migration-Service_64.png", "DMS"), ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "Flink")]
    for i, (lb, col, fill) in enumerate(regions):
        x = 70 + i * (rw + gap)
        c.panel(x, y, rw, rh, fill=fill, outline=col, width=3)
        c.text(x + 20, y + 12, lb, 19, col, True, maxw=rw - 40)
        grid_icons(c, [(ic, n, None) for ic, n in mini], x + 10, y + 70, rw - 20, 4, rowh=118, size=56, lw=130)
        c.text(x + 20, y + rh - 70, "本区:数仓 · 湖 · 调度器 · 日志 · 审计原文 · 每区执行角色(aws:RequestedRegion 锁区)· 零出网", 14, GRAY, maxw=rw - 40)
        # 箭头:控制面 ↔ 区
        cx = x + rw / 2
        c.arrow((cx - 30, CY + CH), (cx - 30, y), color=PURPLE, width=4)
        c.arrow((cx + 30, y), (cx + 30, CY + CH), color=BLUE, width=4, dashed=True)
    c.text(440, 492, "✕ 区与区之间没有任何数据流", 15, INK, True)
    c.text(440, 518, "每区的数仓 / 湖 / 日志 / 审计原文都留在本区", 14, GRAY)
    c.text(1070, 486, "↓ 紫实线:控制面 → 区(下发定义 · CodeBuild 部署 · 探活)", 14, PURPLE, True, maxw=500)
    c.text(1070, 512, "↑ 蓝虚线:区 → 控制面(只回写运行元数据,唯一跨区调用)", 14, BLUE, True, maxw=500)
    # 四条机制
    y2 = 990
    mech = [("① 执行范围是第一公民", "顶栏三层:项目空间 → 环境 → 执行范围;读接口只认 URL ?scope=,写接口不读 scope;服务端一律不回落。"),
            ("② 落点必须显式", "每个对象 / 每次运行都带 targetId(「在哪个区执行」);入口缺落点一律 400,不默认主控区;凭证只经落点取得。"),
            ("③ 禁止跨区取数", "源数据源与任务落点不一致 ⇒ 409 永久拒、零副作用;每区执行角色用 aws:RequestedRegion 锁区;执行 VPC 零出网。"),
            ("④ 每区自治调度", "每个区一个 MWAA Serverless:DAG、触发、节点状态、日志全在本区;只有运行元数据回写主控区。")]
    mw = (1860 - 3 * 20) / 4
    for i, (hd, body) in enumerate(mech):
        x = 70 + i * (mw + 20)
        c.panel(x, y2, mw, 190, fill=PANEL, outline=LIGHT)
        c.d.rounded_rectangle((x, y2, x + 10, y2 + 190), radius=5, fill=BLUE if i % 2 else PURPLE)
        c.text(x + 26, y2 + 14, hd, 20, INK, True)
        c.text(x + 26, y2 + 54, body, 15, GRAY, maxw=mw - 46)
    c.panel(70, 1200, 1860, 56, fill=PURPLE, outline=PURPLE)
    c.d.text((1000, 1228), "一个原则:不为非主控区另开第二套系统 —— 一个 AgentCore、一个 OpenMetadata、一套 Cognito / DynamoDB / 审批 / 审计;「哪个区」是落点与 service 维度", font=F(18, True), fill=WHITE, anchor="mm")
    c.footer("Kingfisher · 合同见 docs/design/50-multi-region-execution/SPEC.md · 图只含服务级信息 · 源:docs/diagrams/src/render_aws_arch.py")
    c.save("aws-multi-region.png")

if __name__ == "__main__":
    overview(); control_plane(); execution_region(); multi_region()
