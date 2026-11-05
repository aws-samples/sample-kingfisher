#!/usr/bin/env python3
"""GenAI plane — 7 user-facing AI capabilities over Bedrock + AgentCore, with the
shared Strands runner / @genbi/core brain / Engine Cookbook cross-cutting layer.

Generate:  python3 docs/diagrams/genai-architecture.py   (run from repo root)
Requires:  pip install diagrams  +  graphviz (dot)
Output:    docs/diagrams/genai-architecture.png

Service-level only — contains NO account IDs / resource IDs / ARNs / URLs.
"""
from diagrams import Diagram, Cluster, Edge
from diagrams.onprem.client import Users
from diagrams.aws.network import CloudFront, APIGateway
from diagrams.aws.compute import Fargate, Lambda
from diagrams.aws.ml import Bedrock
from diagrams.aws.database import Dynamodb, Redshift
from diagrams.aws.storage import S3
from diagrams.aws.analytics import Athena
from diagrams.aws.management import Cloudwatch
from diagrams.aws.general import General

graph_attr = {"fontsize": "17", "bgcolor": "white", "pad": "0.6", "nodesep": "0.5", "ranksep": "0.85"}

with Diagram(
    "GenAI Plane — 7 user-facing AI capabilities (Bedrock + AgentCore)",
    filename="docs/diagrams/genai-architecture",
    outformat="png",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
):
    users = Users("Users\n(business / dev / ops)")
    cdn = CloudFront("CloudFront")

    # ---- 7 user-facing AI capabilities, all served by the Next.js platform ----
    with Cluster("Platform — ECS Fargate (Next.js)  ·  7 AI capabilities"):
        ask = Fargate("GenBI Ask-Your-Data\n(/api/genbi/ask)")
        copilot = Fargate("Platform Copilot\n(plan/exec, create-yes exec-no)")
        advisors = Fargate("Network + Parameter\nadvisors")
        codegen = Fargate("AI codegen\n(ETL PySpark/SQL + Flink SQL)")
        devopsq = Fargate("DevOps diagnosis\n(memory-augmented)")

    # ---- Shared foundation: one brain + one runner + one dialect guard ----
    with Cluster("Shared foundation (cross-cutting)"):
        core = General("@genbi/core\n(single brain)")
        strands = General("Strands runner\n(unified assembly,\nai-model.json SSOT)")
        cookbook = General("Engine Cookbook\n(dialect guard,\nall codegen exits)")

    # Icon pinned to the top of the node box and two blank caption lines at the bottom, so that edges
    # arriving from above meet the icon and edges arriving from below stop under the caption text.
    bedrock = Bedrock("Bedrock Converse\n(Claude Opus)\nNL→SQL / retrieval /\nsummary / codegen\n\n", imagepos="tc", height="2.8")

    # ---- AgentCore: 3 stacks. GenBI runtime live; advisors inprocess-default ----
    with Cluster("Bedrock AgentCore — 3 stacks"):
        gateway = APIGateway("Gateway (MCP)\nAuthorizer=AWS_IAM")
        skills = Lambda("Skills Lambda\n(8 MCP tools,\nread-only guard + EMF)")
        runtime = Fargate("GenBI Runtime\n(ARM64, /invocations)")
        memory = General("Memory\n(events + semantic\nlong-term records)")
        advruntime = Fargate("Net / Param Runtime\n(stack defined; gated,\ninprocess by default)")

    with Cluster("Self-managed memory (fallback)"):
        turns = Dynamodb("DynamoDB\nbgp-genbi-turns\n(short-term, TTL)")
        summaries = S3("S3 genbi-memory\n(long-term summaries)")

    with Cluster("Data engines (read-only)"):
        rs = Redshift("Redshift\nServerless")
        athena = Athena("Athena\n(S3 Tables / Iceberg)")

    with Cluster("Knowledge / skills registry"):
        ctx = Dynamodb("bgp-genbi-context\n(business definitions)")
        reg = Dynamodb("bgp-genbi-skills\n(registered skills)")

    with Cluster("Diagnostics evidence"):
        cw = Cloudwatch("CloudWatch / Glue /\nData API (evidence)")

    # ---- Request path ----
    users >> Edge(label="HTTPS") >> cdn >> ask

    # ---- All capabilities share the foundation, which fronts Bedrock ----
    for cap in (ask, copilot, advisors, codegen, devopsq):
        cap >> Edge(color="gray", style="dotted") >> core
    # weight=10 keeps these edges straight so they meet the target icon instead of its caption text
    core >> Edge(weight="10") >> strands
    strands >> Edge(color="orange", label="Converse") >> bedrock
    codegen >> Edge(color="brown", style="dashed", label="dialect guard", weight="10") >> cookbook
    cookbook >> Edge(color="brown", style="dashed") >> bedrock

    # ---- GenBI dual backend: inprocess Converse OR AgentCore runtime ----
    ask >> Edge(color="darkgreen", label="agentcore: InvokeAgentRuntime (IAM)", weight="10") >> runtime
    runtime >> Edge(color="orange", label="Converse loop", decorate="true") >> bedrock  # decorate: leader line ties the label to its edge
    runtime >> Edge(color="purple", label="MCP + SigV4") >> gateway
    gateway >> Edge(label="GATEWAY_IAM_ROLE") >> skills
    skills >> Edge(color="darkblue", label="read-only SQL") >> rs
    skills >> Edge(color="darkblue", label="read-only SQL") >> athena
    skills >> Edge(style="dashed") >> ctx
    skills >> Edge(style="dashed") >> reg

    # ---- Advisors: AgentCore stacks defined, but inprocess by default ----
    advisors >> Edge(color="gray", style="dashed", label="inprocess default /\nagentcore when enabled") >> advruntime

    # ---- Memory: switchable backend ----
    ask >> Edge(color="brown", label="CreateEvent / RetrieveMemoryRecords") >> memory
    ask >> Edge(color="gray", style="dashed", label="selfmanaged fallback") >> turns
    ask >> Edge(color="gray", style="dashed") >> summaries

    # ---- DevOps diagnosis: correlate managed telemetry ----
    devopsq >> Edge(color="red", style="dashed", label="correlate logs/metrics") >> cw
