#!/usr/bin/env python3
"""OpenMetadata metadata-ingestion architecture,
AWS official icons.

Generate:  python3 docs/diagrams/src/om-ingestion-architecture.py   (run from repo root)
Output:    docs/diagrams/om-ingestion-architecture.png

Three complementary paths feed OpenMetadata:
  ① Scheduled connector ingestion: EventBridge Scheduler → ECS Fargate (openmetadata/ingestion)
  ② Event-driven push on each sync run (cross-system column-level lineage + S3 Tables schema)
  ③ Compute-task lineage push on each job (EMR / Flink / ETL / Redshift-SQL inputs → outputs)
Service-level only — no account IDs / resource IDs / URLs.
"""
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.integration import EventbridgeScheduler
from diagrams.aws.compute import Fargate
from diagrams.aws.database import Redshift, RDSMysqlInstance, Dynamodb
from diagrams.aws.analytics import GlueDataCatalog, EMR, KinesisDataAnalytics
from diagrams.aws.storage import S3
from diagrams.aws.security import SecretsManager

graph_attr = {"fontsize": "18", "bgcolor": "white", "pad": "0.6", "nodesep": "0.55", "ranksep": "1.05"}

with Diagram(
    "OpenMetadata Metadata Ingestion",
    filename="docs/diagrams/om-ingestion-architecture",
    outformat="png",
    show=False,
    direction="LR",
    graph_attr=graph_attr,
):
    secrets = SecretsManager("Secrets Manager\n(ingestion-bot JWT)")

    with Cluster("① Scheduled connector ingestion", graph_attr={"margin": "44"}):
        sched = EventbridgeScheduler("EventBridge\nScheduler")
        task = Fargate("ECS Fargate task\n(openmetadata/ingestion)")
        sched >> Edge(label="RunTask") >> task

    # Sources are 4-paradigm, not a single MySQL anymore.
    with Cluster("Sources — 4 paradigms"):
        rs = Redshift("Redshift")
        glue = GlueDataCatalog("Glue / S3 Tables")
        lake = S3("S3 Data Lake")
        src = RDSMysqlInstance("JDBC ×4")
        src_ddb = Dynamodb("DynamoDB")

    # Compute engines whose job lineage is also pushed to OM (path 3).
    with Cluster("Compute engines (job lineage)"):
        emr = EMR("EMR Serverless")
        flink = KinesisDataAnalytics("MSAF Flink")

    with Cluster("Governance\nsystem\nof record", graph_attr={"margin": "32"}):
        om = Fargate("OpenMetadata\n(catalog + lineage)")

    app = Fargate("Platform\n(sync + compute runs)")

    # ---- Path 1: scheduled connectors read sources, push metadata to OM ----
    task >> Edge(label="Redshift / Glue / S3\nconnectors", weight="5") >> rs
    task >> glue
    task >> lake
    task >> Edge(taillabel="metadata-rest", labelfontcolor="purple", labeldistance="11", labelangle="15", color="purple") >> om
    secrets >> Edge(style="dashed", color="firebrick", headlabel="JWT", labelfontcolor="firebrick", labeldistance="2", labelangle="60") >> task
    secrets >> Edge(style="dashed", color="firebrick", headlabel="JWT", labelfontcolor="firebrick", labeldistance="5.3", labelangle="-75") >> app

    # ---- Path 2: event push on sync run (column-level lineage + S3 Tables schema) ----
    app >> Edge(color="darkred", style="bold",
               headlabel="② sync run: source → S3 Tables → Redshift\n(column-level lineage +\nS3 Tables schema backfill)", labeldistance="20", labelangle="16") >> om

    # ---- Path 3: compute-task lineage push on each job ----
    emr >> Edge(color="gray") >> app
    flink >> Edge(color="gray") >> app
    app >> Edge(color="darkgreen", style="bold",
               label="③ compute job: EMR / Flink / ETL / Redshift-SQL\n(inputs → outputs + SQL parse)") >> om

    # ---- Sources feed the platform ----
    src >> Edge(style="dotted", color="gray") >> app
    src_ddb >> Edge(style="dotted", color="gray") >> app
