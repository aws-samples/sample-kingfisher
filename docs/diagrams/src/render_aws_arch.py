#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render Kingfisher's four AWS service-view figures (static PNG, white background) with the official AWS
Architecture Icons (Architecture Icons release 2026-07-31, src/aws-icons/):
  aws-overview.png          one control plane × N data planes
  aws-control-plane.png     home-region control plane (23 CDK stacks in six layers)
  aws-execution-region.png  execution-region data plane (one BgpExecEnv-<slug>-* stack group per region)
  aws-multi-region.png      multi-region mechanics: execution scope / place / no cross-region reads / scheduling per region
Service-level information only: no account ids, resource ids or URLs.
Re-render: python3 docs/diagrams/src/render_aws_arch.py  (the four files are written into docs/diagrams/ regardless
of the working directory).
Dependencies: Pillow + Noto Sans CJK (/usr/share/fonts/google-noto-cjk). The CJK-capable face is kept on purpose:
it ships the Latin glyphs these figures have always used together with every symbol they need (× → ⇒ ↑ ↓ ① – ④ · —).
Layout guard: every caption is measured against the space reserved for it; anything wider is reported on stderr as
"layout warning" so that a wording change cannot silently overflow a box."""
import os
import sys
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

_WARN = []
def warn(msg):
    _WARN.append(msg)

INK, GRAY, LIGHT = (35, 47, 62), (84, 91, 100), (213, 219, 219)
BG, PANEL, PANEL2 = (255, 255, 255), (247, 248, 250), (238, 241, 245)
PURPLE, PURPLE_L = (90, 48, 181), (236, 230, 250)
BLUE, BLUE_L = (0, 115, 187), (227, 240, 250)
ORANGE, ORANGE_L = (236, 114, 17), (255, 240, 224)
GREEN = (29, 129, 2)
SLATE = (120, 130, 140)
WHITE = (255, 255, 255)

class Canvas:
    def __init__(self, w, h):
        self.im = Image.new("RGB", (w, h), BG)
        self.d = ImageDraw.Draw(self.im)
        self.w, self.h = w, h
    def text(self, x, y, s, size=20, color=INK, bold=False, anchor="la", maxw=None, avail=None, maxlines=None):
        """Draw one caption. maxw wraps at word boundaries; avail only checks a single line against the room it has."""
        f = F(size, bold)
        if maxw:
            lines = wrap(s, f, maxw)
            if maxlines and len(lines) > maxlines:
                warn(f"{len(lines)} lines (max {maxlines}) for: {s[:60]}…")
            for line in lines:
                self.d.text((x, y), line, font=f, fill=color, anchor=anchor)
                y += int(size * 1.45)
            return y
        if avail is not None and self.tw(s, size, bold) > avail:
            warn(f"{int(self.tw(s, size, bold))}px > {int(avail)}px available for: {s[:60]}…")
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
        if name.startswith("Res_"):  # resource icons are white line art (dark theme); tint them ink on the white background
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
        """Figure title (shrinks from 40 px until it fits the line) and a subtitle of one or two lines."""
        x = 70
        if tag:
            self.d.rounded_rectangle((x, 52, x + 10, 118), radius=4, fill=BLUE); x += 30
        avail = self.w - 70 - x
        size = 40
        while size > 30 and self.tw(s, size, True) > avail:
            size -= 2
        if self.tw(s, size, True) > avail:
            warn(f"title still {int(self.tw(s, size, True))}px > {avail}px at {size}px: {s[:60]}…")
        self.d.text((x, 44 + (40 - size) // 2), s, font=F(size, True), fill=INK)
        if sub:
            lines = wrap(sub, F(19), avail)
            if len(lines) > 2:
                warn(f"subtitle needs {len(lines)} lines (max 2): {sub[:60]}…")
            y = 98 if len(lines) > 1 else 106
            for line in lines:
                self.d.text((x, y), line, font=F(19), fill=GRAY); y += 25
        self.d.line([(70, 154), (self.w - 70, 154)], fill=LIGHT, width=2)
    def footer(self, s):
        self.text(70, self.h - 46, s, 15, GRAY, avail=self.w - 140)
    def save(self, name):
        p = os.path.join(OUT, name); self.im.save(p, optimize=True); print("wrote", p, self.im.size)

def wrap(s, font, maxw):
    """Wrap at word boundaries to a pixel width; a single token wider than the line is split by character."""
    lines = []
    for para in s.split("\n"):
        cur = ""
        for word in para.split(" "):
            cand = word if not cur else cur + " " + word
            if font.getlength(cand) <= maxw:
                cur = cand; continue
            if cur:
                lines.append(cur); cur = ""
            while font.getlength(word) > maxw and len(word) > 1:  # oversized token: hard split
                i = len(word)
                while i > 1 and font.getlength(word[:i]) > maxw:
                    i -= 1
                lines.append(word[:i]); word = word[i:]
            cur = word
        lines.append(cur)
    return lines

def check_labels(c, labels, lo, hi, gap=10):
    """labels = [(cx, text, size)] of one row of bold icon captions: none may cross [lo, hi] or come within `gap` px of its neighbour."""
    prev = None
    for cx, lb, size in sorted(labels):
        half = c.tw(lb, size, True) / 2
        if cx - half < lo or cx + half > hi:
            warn(f"label '{lb}' crosses its panel edge ({int(cx - half)}..{int(cx + half)} vs {int(lo)}..{int(hi)})")
        if prev and cx - half - prev[0] < gap:
            warn(f"labels '{prev[1]}' and '{lb}' collide ({int(cx - half - prev[0])}px apart)")
        prev = (cx + half, lb)

def grid_icons(c, items, x, y, w, cols, rowh=175, size=80, lw=None, lsize=19, ssize=15, bounds=None):
    cw = w / cols
    rows = {}
    for i, (ic, lb, sb) in enumerate(items):
        r, col = divmod(i, cols)
        cx = x + cw * (col + 0.5)
        bottom = c.icon(cx, y + r * rowh, ic, lb, sb, size=size, lsize=lsize, ssize=ssize, lw=lw or int(cw - 16))
        if bottom - (y + r * rowh) > rowh:
            warn(f"grid cell {int(bottom - (y + r * rowh))}px taller than row {rowh}px: {lb}")
        rows.setdefault(r, []).append((cx, lb, lsize))
    lo, hi = bounds or (x - 8, x + w + 8)
    for labels in rows.values():
        check_labels(c, labels, lo, hi)
    return y + (len(rows)) * rowh

# ──────────────────────────── 1. Overview ────────────────────────────
def overview():
    c = Canvas(2000, 1230)
    c.title("Kingfisher architecture: one control plane × N data planes",
            "One AWS account · multiple regions · fully managed services. The home region hosts the control plane (web app, metadata, "
            "AI agents); every execution region runs its own data plane (warehouse, lake, compute, scheduling, streaming) and data "
            "never leaves its region.", tag=True)
    # Entry chain
    y0 = 185
    chain = [("Res_Users_48_Dark.png", "Users / browser", "Chinese or English UI"), ("Arch_Amazon-CloudFront_64.png", "CloudFront", "Only public entry point"),
             ("Arch_AWS-WAF_64.png", "WAF", "WebACL · rate limiting"), ("Arch_Elastic-Load-Balancing_64.png", "ALB", "Accepts CloudFront prefixes only"),
             ("Arch_Amazon-Elastic-Container-Service_64.png", "ECS Fargate", "Next.js full stack · API as BFF"), ("Arch_Amazon-Cognito_64.png", "Cognito", "ID token checked on every /api/*")]
    xs = [150, 380, 610, 840, 1070, 1300]
    for (ic, lb, sb), x in zip(chain, xs):
        c.icon(x, y0, ic, lb, sb, lw=200)
        if x != xs[-1]:
            c.arrow((x + 52, y0 + 40), (x + 230 - 52, y0 + 40), color=ORANGE, width=5)
    check_labels(c, [(x, lb, 19) for (ic, lb, sb), x in zip(chain, xs)], 40, 1460)
    c.panel(1470, y0 - 10, 460, 172, fill=ORANGE_L, outline=ORANGE)
    c.text(1495, y0 + 6, "Security boundary", 20, ORANGE, True)
    c.text(1495, y0 + 40, "Resource-level RBAC (workspace owner / editor / viewer) · approval flow · every write is audited · all back ends in "
           "private subnets · the TaskRole calls AWS APIs directly, no long-lived keys · KMS CMK encryption", 15, GRAY, maxw=415, maxlines=5)
    # Control plane
    L, T, PW, PH = 70, 380, 880, 560
    c.panel(L, T, PW, PH, fill=PANEL, outline=PURPLE, width=3)
    c.text(L + 24, T + 16, "Control plane · home region · one instance, never replicated", 24, PURPLE, True, avail=PW - 48)
    c.text(L + 24, T + 52, "Home region chosen by the customer at install · identity · ledgers · catalog · business glossary · AI brain · approvals / audit · "
           "execution-environment deployment broker", 17, GRAY, maxw=PW - 48, maxlines=2)
    ctrl = [("Arch_Amazon-Cognito_64.png", "Cognito", "Identity · workspace RBAC"), ("Arch_Amazon-DynamoDB_64.png", "DynamoDB", "72 control tables · run ledgers"),
            ("Arch_AWS-Secrets-Manager_64.png", "Secrets Manager", "Credentials · nothing hard-coded"), ("Arch_AWS-Key-Management-Service_64.png", "KMS", "CMK encryption"),
            ("Arch_AWS-CodeBuild_64.png", "CodeBuild", "Deploys execution environments"),
            ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", "ECS · governance source of truth"), ("Arch_Amazon-RDS_64.png", "RDS MySQL", "OpenMetadata database"),
            ("Arch_Amazon-OpenSearch-Service_64.png", "OpenSearch", "OpenMetadata search"), ("Arch_Amazon-Bedrock_64.png", "Bedrock", "Claude / GPT / GLM / Kimi model families"),
            ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore", "Ask-Your-Data · Network Advisor · Parameter Advisor")]
    grid_icons(c, ctrl, L + 20, T + 112, PW - 40, 5, rowh=195, bounds=(L + 8, L + PW - 8))
    c.text(L + 24, T + PH - 42, "+ CloudWatch / CloudTrail observability and audit · AWS DevOps Agent diagnostics · all 23 stacks deployed by CDK",
           15, GRAY, avail=PW - 48)
    # Data planes
    L2, PW2 = 990, 940
    c.panel(L2, T, PW2, PH, fill=PANEL, outline=BLUE, width=3)
    c.text(L2 + 24, T + 16, "Data plane · one per region (tgt_*) · data and scheduling stay in region", 24, BLUE, True, avail=PW2 - 48)
    c.text(L2 + 24, T + 52, "Compute · storage · scheduling · network · IAM are replicated per region; registering a region in the web wizard has "
           "CodeBuild build it with CDK", 17, GRAY, maxw=PW2 - 48, maxlines=2)
    exe = [("Arch_Amazon-Virtual-Private-Cloud_64.png", "VPC", "Zero egress · interface endpoints only"), ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 / S3 Tables", "Data lake · Iceberg"),
           ("Arch_Amazon-EMR_64.png", "EMR Serverless", "Spark compute"), ("Arch_AWS-Glue_64.png", "Glue", "Batch sync · PySpark"),
           ("Arch_Amazon-Redshift_64.png", "Redshift Serverless", "Warehouse · Data API"), ("Arch_Amazon-Athena_64.png", "Athena", "Direct lake queries"),
           ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA Serverless", "Autonomous scheduling per region"), ("Arch_AWS-Database-Migration-Service_64.png", "DMS", "Real-time CDC"),
           ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "Managed Flink", "Stream compute"), ("Arch_Amazon-Managed-Streaming-for-Apache-Kafka_64.png", "MSK", "Streaming source"),
           ("Arch_AWS-Identity-and-Access-Management_64.png", "IAM", "Regional roles · region-fenced"), ("Arch_AWS-CloudFormation_64.png", "CloudFormation", "One stack group per region")]
    grid_icons(c, exe, L2 + 20, T + 112, PW2 - 40, 6, rowh=195, bounds=(L2 + 8, L2 + PW2 - 8))
    px = L2 + 24; py = T + PH - 48
    for lb, col in (("Home region · tgt_home (also runs a data plane)", PURPLE), ("Execution region 1 · tgt_<slug>", BLUE), ("… execution region N", SLATE)):
        px += c.pill(px, py, lb, col, size=15, padx=16) + 14
    if px - 14 > L2 + PW2 - 20:
        warn(f"region pills end at {px - 14}px, panel ends at {L2 + PW2 - 20}px")
    # Bottom band: the two channels and the principle
    c.panel(70, 975, 1860, 150, fill=PANEL2, outline=LIGHT)
    c.arrow((400, 1015), (520, 1015), color=PURPLE, width=5)
    c.text(90, 1000, "Control plane → data plane", 20, PURPLE, True, avail=300)
    c.text(540, 1003, "Pushes task definitions · CodeBuild deploys the stack group · probes and installs missing components · IAM allows only enabled "
           "regions via aws:RequestedRegion", 17, GRAY, avail=1390)
    c.arrow((520, 1060), (400, 1060), color=BLUE, width=5, dashed=True)
    c.text(90, 1045, "Data plane → control plane", 20, BLUE, True, avail=300)
    c.text(540, 1048, "Writes back run metadata only (the single cross-region call): VPC peering + an interface endpoint in the home VPC + a private "
           "hosted zone · no application-code change", 17, GRAY, avail=1390)
    c.text(90, 1090, "Data never crosses regions", 20, INK, True, avail=300)
    c.text(540, 1093, "The platform never replicates across regions: warehouse, lake, logs, DAGs and full audit records stay in their region — "
           "meeting data-residency and jurisdiction requirements", 17, GRAY, avail=1390)
    c.footer("Kingfisher · big data governance and development platform · service-level view only: no account ids, resource ids or URLs · "
             "source: docs/diagrams/src/render_aws_arch.py")
    c.save("aws-overview.png")

# ──────────────────────────── 2. Control plane ────────────────────────────
def control_plane():
    c = Canvas(2000, 1400)
    c.title("Home-region control plane: 23 CDK stacks in six layers (17 always deployed + 6 gated by context)",
            "Entry point infra/bin/app.ts · stack names are prefixed Bgp* · wiring facts are written to SSM /bgp/wiring/* and read back "
            "automatically at synth time", tag=True)
    layers = [
        ("Edge and application", ORANGE, [
            ("Arch_Amazon-CloudFront_64.png", "CloudFront", "Only public entry point"), ("Arch_AWS-WAF_64.png", "WAF", "Pinned to us-east-1 · WebACL"),
            ("Arch_Elastic-Load-Balancing_64.png", "ALB", "Accepts CloudFront prefixes only"), ("Arch_Amazon-Elastic-Container-Service_64.png", "ECS Fargate platform", "Next.js · 40 pages · 309 API routes"),
            ("Arch_Amazon-Cognito_64.png", "Cognito", "User pool · checked on every /api/*")],
         "BgpWafStack · BgpPlatformStack (ECS + TaskRole + ALB + CloudFront) · BgpAuthStack"),
        ("State · identity · network", PURPLE, [
            ("Arch_Amazon-DynamoDB_64.png", "DynamoDB, 72 tables", "Registry · run ledgers · long-operation leases"), ("Arch_AWS-Secrets-Manager_64.png", "Secrets Manager", "Data-source and warehouse credentials"),
            ("Arch_AWS-Key-Management-Service_64.png", "KMS", "CMK · everything encrypted at rest"), ("Arch_Amazon-Virtual-Private-Cloud_64.png", "VPC", "Private subnets · interface endpoints"),
            ("Arch_AWS-Identity-and-Access-Management_64.png", "IAM", "TaskRole from a manifest of 127 real calls")],
         "BgpDatabaseStack (67 tables) · BgpFinOpsStack (3 tables) · BgpKmsStack · BgpVpcStack"),
        ("Metadata and agents", GREEN, [
            ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", "ECS · source of truth for catalog / lineage / quality"), ("Arch_Amazon-RDS_64.png", "RDS MySQL", "OpenMetadata database"),
            ("Arch_Amazon-OpenSearch-Service_64.png", "OpenSearch", "OpenMetadata search"), ("Arch_Amazon-Bedrock_64.png", "Bedrock", "Claude Opus / GPT / GLM / Kimi"),
            ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore × 3", "Ask-Your-Data · Network Advisor · Parameter Advisor"), ("Arch_AWS-DevOps-Agent_64.png", "DevOps Agent", "AI diagnosis of failed runs")],
         "BgpOmDatabaseStack · BgpOmSearchStack · BgpOmServiceStack · BgpAgentCoreStack · BgpNetAdvisorAgentCoreStack · BgpParamAdvisorAgentCoreStack · BgpOmIngestionStack (gated)"),
        ("Region deployment mechanism", BLUE, [
            ("Arch_AWS-Lambda_64.png", "broker Lambda", "Sole caller of StartBuild"), ("Arch_AWS-CodeBuild_64.png", "CodeBuild", "Bootstraps and runs cdk deploy in the target region"),
            ("Arch_AWS-CloudFormation_64.png", "CloudFormation", "BgpExecEnv-<slug>-* stack group"), ("Arch_AWS-Lambda_64.png", "action-dispatcher", "Scheduler callbacks into platform actions"),
            ("Arch_AWS-Lambda_64.png", "xregion-peering", "Private cross-region write-back channel")],
         "BgpExecEnvDeployStack (the platform TaskRole cannot call StartBuild; the \"New execution environment\" page is the only entry point)"),
        ("Home-region data plane (same shape as an execution region)", BLUE, [
            ("Arch_Amazon-Redshift_64.png", "Redshift Serverless", "Home-region warehouse"), ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA Serverless", "Home-region scheduler"),
            ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 / S3 Tables", "Data lake · scripts bucket"), ("Arch_AWS-Glue_64.png", "Glue", "Sync and discovery jobs"),
            ("Arch_Amazon-EMR_64.png", "EMR Serverless", "Gated: -c enable-emr"), ("Arch_AWS-Database-Migration-Service_64.png", "DMS", "Gated: -c enable-realtime"),
            ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "Managed Flink", "Gated: -c enable-flink")],
         "BgpRedshiftStack · BgpAirflowServerlessStack · BgpRealtimeStack / BgpFlinkStack / BgpEmrStack (gated) · BgpRdsStack (demo source database only) · BgpMwaaStack (classic, gated)"),
        ("Observability and audit", GRAY, [
            ("Arch_Amazon-CloudWatch_64.png", "CloudWatch", "Platform and job logs · metrics"), ("Arch_AWS-CloudTrail_64.png", "CloudTrail", "AWS API call audit"),
            ("Arch_Amazon-DynamoDB_64.png", "bgp-audit", "Every write · duplicated for non-home jurisdictions")],
         "BgpAuditStack · platform audit table (the \"Audit Log\" page)"),
    ]
    y = 175
    for name, col, items, stacks in layers:
        h = 190
        c.panel(70, y, 1860, h, fill=PANEL, outline=col, width=3)
        c.d.rounded_rectangle((70, y, 300, y + h), radius=16, fill=col)
        c.d.rectangle((285, y, 300, y + h), fill=col)
        lsz = 24
        lines = wrap(name, F(lsz, True), 210)
        while len(lines) > 3 and lsz > 18:  # long layer names: shrink the side label rather than overflow the strip
            lsz -= 2; lines = wrap(name, F(lsz, True), 210)
        step = int(lsz * 1.5)
        for i, line in enumerate(lines):
            c.d.text((185, y + h / 2 - (len(lines) - 1) * step / 2 + i * step), line, font=F(lsz, True), fill=WHITE, anchor="mm")
        n = len(items); cw = 1540 / max(n, 5)
        for i, (ic, lb, sb) in enumerate(items):
            bottom = c.icon(330 + cw * (i + 0.5), y + 14, ic, lb, sb, size=72, lsize=18, ssize=14, lw=int(cw - 12))
            if bottom > y + h - 30:
                warn(f"layer '{name}': caption of {lb} reaches {int(bottom - y)}px, stack line starts at {h - 28}px")
        check_labels(c, [(330 + cw * (i + 0.5), lb, 18) for i, (ic, lb, sb) in enumerate(items)], 310, 1922)
        c.text(330, y + h - 28, stacks, 14, GRAY, avail=1590)
        y += h + 2
    c.footer("Kingfisher · the stack list follows infra/bin/app.ts · service-level view only · source: docs/diagrams/src/render_aws_arch.py")
    c.save("aws-control-plane.png")

# ──────────────────────────── 3. Execution-region data plane ────────────────────────────
def execution_region():
    c = Canvas(2000, 1260)
    c.title("Execution-region data plane: one full BgpExecEnv-<slug>-* stack group per region",
            "Components cannot be trimmed, one group per region · built by CodeBuild with CDK from the System → Execution Environments → New "
            "wizard · zero-egress VPC, all AWS calls through interface endpoints · data never leaves the region", tag=True)
    # Region frame
    RX, RY, RW, RH = 70, 175, 1340, 900
    c.panel(RX, RY, RW, RH, fill=BG, outline=BLUE, width=3, radius=22)
    c.pill(RX + 24, RY - 18, "AWS Region · execution region (example: tgt_<slug>)", BLUE, size=18)
    # VPC frame
    VX, VY, VW, VH = RX + 30, RY + 50, RW - 60, 520
    c.panel(VX, VY, VW, VH, fill=PANEL, outline=SLATE, width=2, radius=18)
    c.icon(VX + 50, VY + 16, "Arch_Amazon-Virtual-Private-Cloud_64.png", None, size=56)
    c.text(VX + 100, VY + 18, "VPC (-base stack)", 19, INK, True)
    c.text(VX + 100, VY + 48, "Private subnets · no NAT / EIP / IGW · all AWS calls through VPC interface endpoints (PrivateLink) · KMS CMKs alias/bgp-data "
           "and alias/bgp-logs", 15, GRAY, maxw=VW - 130, maxlines=1)
    # Three columns: compute / storage / scheduling and streaming
    colw = (VW - 60) / 3
    cols = [
        ("Compute and query (-core / -redshift stacks)", [
            ("Arch_AWS-Glue_64.png", "AWS Glue", "Batch sync · discovery jobs · PySpark"), ("Arch_Amazon-EMR_64.png", "EMR Serverless", "Spark batch compute"),
            ("Arch_Amazon-Athena_64.png", "Athena", "Direct lake queries · federated catalog"), ("Arch_Amazon-Redshift_64.png", "Redshift Serverless", "Regional warehouse · Data API")]),
        ("Storage (-base stack · data resources are retained on decommission)", [
            ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 lake bucket", "Raw data / scripts / outputs"), ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 Tables bucket", "Iceberg · s3tablescatalog"),
            ("Arch_AWS-Key-Management-Service_64.png", "KMS CMK", "Regional keys"), ("Arch_AWS-Secrets-Manager_64.png", "Secrets Manager", "Warehouse credentials per workspace and region")]),
        ("Scheduling and streaming (-airflow-serverless / -dms / -flink stacks)", [
            ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA Serverless", "Autonomous regional scheduling · DAG bucket"), ("Arch_AWS-Database-Migration-Service_64.png", "DMS", "Replication instance · CDC tasks"),
            ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "Managed Flink", "SQL runner · S3 Tables sink"), ("Arch_Amazon-Managed-Streaming-for-Apache-Kafka_64.png", "MSK", "Streaming source (read-only)")]),
    ]
    for i, (hd, items) in enumerate(cols):
        x = VX + 20 + colw * i + 10 * i
        c.panel(x, VY + 95, colw, VH - 115, fill=BG, outline=LIGHT)
        c.text(x + 16, VY + 105, hd, 17, BLUE, True, maxw=colw - 30, maxlines=2)
        grid_icons(c, items, x + 8, VY + 160, colw - 16, 2, rowh=165, size=68, lw=int(colw / 2 - 20))
    # Below the VPC: IAM / CloudFormation / residency / logs
    y2 = VY + VH + 20
    row = [("Arch_AWS-Identity-and-Access-Management_64.png", "IAM (-core stack)", "Regional execution roles · platform data-plane role · fenced to this region by aws:RequestedRegion"),
           ("Arch_AWS-CloudFormation_64.png", "CloudFormation", "base · core · redshift · dms · flink · airflow-serverless · residency-api (non-home jurisdictions only)"),
           ("Arch_AWS-Lambda_64.png", "residency-api", "Installed only for non-home jurisdictions: residency API · dual audit"),
           ("Arch_Amazon-CloudWatch_64.png", "CloudWatch", "Job / scheduler / streaming logs stay in the region")]
    cw = (RW - 60) / 4
    for i, (ic, lb, sb) in enumerate(row):
        c.icon(RX + 30 + cw * (i + 0.5), y2, ic, lb, sb, size=68, lsize=17, ssize=14, lw=int(cw - 24))
    check_labels(c, [(RX + 30 + cw * (i + 0.5), lb, 17) for i, (ic, lb, sb) in enumerate(row)], RX + 8, RX + RW - 8)
    c.text(RX + 30, RY + RH - 130, "Purple solid = control plane → this region (pushes task definitions · CodeBuild deploys the stack group · probes and installs "
           "missing components); blue dashed = this region → control plane (writes back run metadata only over the private cross-region VPC "
           "peering path — the single cross-region call)", 15, GRAY, maxw=RW - 60, maxlines=2)
    c.text(RX + 30, RY + RH - 75, "This region hosts: data sources · sync tasks · batch jobs · orchestration workflows · direct queries · streaming jobs · governance "
           "quality and sensitive scans · modeling landings · Ask-Your-Data queries — switch the page's execution scope to the region to see its objects",
           15, GRAY, maxw=RW - 60, maxlines=2)
    # Right: the home region writes
    HX, HY, HW, HH = 1560, 175, 370, 900
    c.panel(HX, HY, HW, HH, fill=PURPLE_L, outline=PURPLE, width=3, radius=22)
    c.pill(HX + 24, HY - 18, "Home region · control plane", PURPLE, size=18)
    items = [("Arch_Amazon-Elastic-Container-Service_64.png", "Platform (ECS)", "Pages / API"), ("Arch_Amazon-DynamoDB_64.png", "DynamoDB", "Run ledgers · registry"),
             ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", "One service per region"), ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore", "Place passed with each call")]
    grid_icons(c, items, HX + 10, HY + 60, HW - 20, 2, rowh=175, size=68, lw=170)
    c.text(HX + 24, HY + 430, "There is only one control plane for the whole platform; \"which region\" is the place (targetId) on each object and the "
           "service dimension in OpenMetadata — not a second system.", 15, GRAY, maxw=HW - 48, maxlines=6)
    # Arrows between the two frames
    gx = RX + RW; gw = HX - gx
    c.arrow((HX, 560), (gx, 560), color=PURPLE, width=5)
    c.d.text((gx + gw / 2, 520), "Push definitions", font=F(15, True), fill=PURPLE, anchor="mm")
    c.d.text((gx + gw / 2, 540), "deploy · probe", font=F(15, True), fill=PURPLE, anchor="mm")
    c.arrow((gx, 660), (HX, 660), color=BLUE, width=5, dashed=True)
    c.d.text((gx + gw / 2, 684), "Write back", font=F(15, True), fill=BLUE, anchor="mm")
    c.d.text((gx + gw / 2, 704), "run metadata only", font=F(15, True), fill=BLUE, anchor="mm")
    for s in ("Push definitions", "deploy · probe", "Write back", "run metadata only"):
        if c.tw(s, 15, True) > gw - 8:
            warn(f"arrow label {s} wider than the {gw}px gap")
    c.panel(70, 1095, 1860, 100, fill=PANEL2, outline=LIGHT)
    c.text(90, 1107, "Lifecycle (driven from the web pages)", 18, INK, True)
    c.text(90, 1140, "Register → CodeBuild deploys → the control plane authorizes the region (skipped when it was pre-authorized with EXEC_REGION_CANDIDATES "
           "at install / upgrade) → Check initialization → Enable → Stop accepting work → Approved deletion (lake bucket / table bucket / final snapshot / "
           "CMK are retained)", 15, GRAY, maxw=1820, maxlines=2)
    c.footer("Kingfisher · the stack group follows infra/lib/exec-env/stack-group.ts · service-level view only · source: docs/diagrams/src/render_aws_arch.py")
    c.save("aws-execution-region.png")

# ──────────────────────────── 4. Multi-region mechanics ────────────────────────────
def multi_region():
    c = Canvas(2000, 1300)
    c.title("How multi-region works: one control plane · N execution regions · four rules · one principle",
            "The execution scope in the page header selects a region · every object and every run carries a place · cross-region reads are "
            "always refused · every region runs its own scheduler", tag=True)
    # Top: browser + scope selector
    c.icon(170, 180, "Res_Users_48_Dark.png", "User", "Sets the execution scope", size=64, lsize=17, ssize=14, lw=220)
    c.panel(300, 185, 1630, 100, fill=PANEL, outline=LIGHT)
    px = 325 + int(c.tw("Execution scope:", 20, True)) + 20
    c.text(325, 203, "Execution scope:", 20, INK, True)
    for lb, col in (("All regions (read-only summary)", SLATE), ("Home region · tgt_home", PURPLE), ("Execution region A · tgt_<slug-a>", BLUE),
                    ("Execution region B · tgt_<slug-b>", BLUE), ("… region N", SLATE)):
        px += c.pill(px, 202, lb, col, size=16) + 16
    if px - 16 > 1910:
        warn(f"scope pills end at {px - 16}px, panel ends at 1910px")
    c.text(325, 252, "URL ?scope= is the authoritative expression · invalid 400 · unknown 404 · not visible 403 · not ready 409 · never a silent "
           "fallback to the home region", 14, GRAY, avail=1580)
    # Control plane
    CX, CY, CW, CH = 70, 300, 1860, 170
    c.panel(CX, CY, CW, CH, fill=PURPLE_L, outline=PURPLE, width=3)
    c.text(CX + 24, CY + 14, "Control plane (home region) · one instance", 22, PURPLE, True, avail=500)
    c.text(CX + 24, CY + 56, "Pages · 72 control tables · identity · governance source of truth · AI agents · deployment broker — never replicated to any "
           "execution region", 15, GRAY, maxw=500, maxlines=4)
    items = [("Arch_Amazon-Elastic-Container-Service_64.png", "Platform ECS", None), ("Arch_Amazon-Cognito_64.png", "Cognito", None), ("Arch_Amazon-DynamoDB_64.png", "DynamoDB", None),
             ("Arch_Amazon-Elastic-Container-Service_64.png", "OpenMetadata", None), ("Arch_Amazon-Bedrock-AgentCore_64.png", "AgentCore", None), ("Arch_AWS-CodeBuild_64.png", "CodeBuild", None)]
    grid_icons(c, items, CX + 560, CY + 40, 1200, 6, rowh=110, size=56, lw=130)
    # Three regions
    regions = [("Home region · tgt_home (hosts the control plane)", PURPLE, PURPLE_L), ("Execution region A · tgt_<slug-a> (e.g. another country / jurisdiction)", BLUE, BLUE_L),
               ("Execution region N · tgt_<slug-n>", BLUE, BLUE_L)]
    rw, rh, gap = 590, 400, 45
    y = 560
    mini = [("Arch_Amazon-Redshift_64.png", "Redshift"), ("Arch_Amazon-Simple-Storage-Service_64.png", "S3 Tables"), ("Arch_AWS-Glue_64.png", "Glue"),
            ("Arch_Amazon-EMR_64.png", "EMR"), ("Arch_Amazon-Athena_64.png", "Athena"), ("Arch_Amazon-Managed-Workflows-for-Apache-Airflow_64.png", "MWAA"),
            ("Arch_AWS-Database-Migration-Service_64.png", "DMS"), ("Arch_Amazon-Managed-Service-for-Apache-Flink_64.png", "Flink")]
    for i, (lb, col, fill) in enumerate(regions):
        x = 70 + i * (rw + gap)
        c.panel(x, y, rw, rh, fill=fill, outline=col, width=3)
        c.text(x + 20, y + 12, lb, 19, col, True, maxw=rw - 40, maxlines=2)
        grid_icons(c, [(ic, n, None) for ic, n in mini], x + 10, y + 78, rw - 20, 4, rowh=118, size=56, lw=130, bounds=(x + 8, x + rw - 8))
        c.text(x + 20, y + rh - 70, "In this region: warehouse · lake · scheduler · logs · full audit records · regional execution role (fenced by "
               "aws:RequestedRegion) · zero egress", 14, GRAY, maxw=rw - 40, maxlines=2)
        # Arrows: control plane ↔ region
        cx = x + rw / 2
        c.arrow((cx - 30, CY + CH), (cx - 30, y), color=PURPLE, width=4)
        c.arrow((cx + 30, y), (cx + 30, CY + CH), color=BLUE, width=4, dashed=True)
    c.text(440, 492, "× No data flows between regions", 15, INK, True, avail=500)
    c.text(440, 518, "Each region's warehouse / lake / logs / audit records stay in that region", 14, GRAY, avail=500)
    c.text(1070, 486, "↓ Purple solid: control plane → region (definitions · deploy · probes)", 14, PURPLE, True, avail=520)
    c.text(1070, 512, "↑ Blue dashed: region → control plane (run metadata write-back only)", 14, BLUE, True, avail=520)
    # The four rules
    y2 = 990
    mech = [("① Execution scope is a first-class citizen", "Three header levels: workspace → environment → execution scope. Read APIs accept only the URL ?scope=, "
             "write APIs ignore scope, and the server never falls back."),
            ("② Place must be explicit", "Every object and every run carries a targetId (where it executes). An entry point without a place gets 400 — "
             "never the home region by default — and credentials are obtained only through the place."),
            ("③ No cross-region reads", "A source whose region differs from the task's place ⇒ 409, permanently refused with zero side effects. Each regional "
             "execution role is fenced by aws:RequestedRegion and execution VPCs have zero egress."),
            ("④ Autonomous scheduling per region", "One MWAA Serverless per region: DAGs, triggers, node states and logs all stay in the region. Only run "
             "metadata is written back to the home region.")]
    mw = (1860 - 3 * 20) / 4
    for i, (hd, body) in enumerate(mech):
        x = 70 + i * (mw + 20)
        c.panel(x, y2, mw, 190, fill=PANEL, outline=LIGHT)
        c.d.rounded_rectangle((x, y2, x + 10, y2 + 190), radius=5, fill=BLUE if i % 2 else PURPLE)
        c.text(x + 26, y2 + 14, hd, 20, INK, True, avail=mw - 44)
        c.text(x + 26, y2 + 54, body, 15, GRAY, maxw=mw - 46, maxlines=6)
    c.panel(70, 1200, 1860, 56, fill=PURPLE, outline=PURPLE)
    principle = ("One principle: no second system for non-home regions — one AgentCore, one OpenMetadata, one set of Cognito / DynamoDB / approvals / "
                 "audit; \"which region\" is a place and a service dimension")
    if c.tw(principle, 18, True) > 1820:
        warn("principle bar text wider than the bar")
    c.d.text((1000, 1228), principle, font=F(18, True), fill=WHITE, anchor="mm")
    c.footer("Kingfisher · contract: docs/design/multi-region-execution.md · service-level view only · source: docs/diagrams/src/render_aws_arch.py")
    c.save("aws-multi-region.png")

if __name__ == "__main__":
    overview(); control_plane(); execution_region(); multi_region()
    for m in _WARN:
        print("layout warning:", m, file=sys.stderr)
    if _WARN:
        print(f"{len(_WARN)} layout warning(s) — the PNGs were written, fix the wording or the box sizes", file=sys.stderr)
