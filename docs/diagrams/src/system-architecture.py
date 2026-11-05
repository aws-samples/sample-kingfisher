#!/usr/bin/env python3
"""System architecture diagram (AWS official icons) for Kingfisher (single-region stage).

Generate:  python3 docs/diagrams/src/system-architecture.py   (run from repo root)
Requires:  pip install diagrams  +  graphviz (dot)
Output:    docs/diagrams/system-architecture.png

Covers the full platform: 4-paradigm data sources -> batch + real-time
ingestion -> lakehouse -> multi-engine compute -> governance (OpenMetadata) + AI plane.
Note: service-level only — contains NO account IDs / resource IDs / URLs.
"""
from diagrams import Diagram, Cluster, Edge
from diagrams.onprem.client import Users
from diagrams.aws.network import CloudFront, ElbApplicationLoadBalancer
from diagrams.aws.compute import Fargate
from diagrams.aws.security import Cognito, SecretsManager
from diagrams.aws.database import Dynamodb, RDSMysqlInstance, Redshift, DMS
from diagrams.aws.analytics import (
    Glue, AmazonOpensearchService, EMR, Athena, KinesisDataAnalytics,
    Kinesis, ManagedStreamingForKafka,
)
from diagrams.aws.storage import S3
from diagrams.aws.management import AmazonManagedWorkflowsApacheAirflow as MWAA
from diagrams.aws.ml import Bedrock

graph_attr = {"fontsize": "18", "bgcolor": "white", "pad": "0.7", "nodesep": "0.9", "ranksep": "2.0"}

with Diagram(
    "Kingfisher — System Architecture (single-region stage)\nAI Plane: 7 AI capabilities (details: genai-architecture.png)",
    filename="docs/diagrams/system-architecture",
    outformat="png",
    show=False,
    direction="TB",
    graph_attr=graph_attr,
):
    users = Users("Users\n(browser)")
    cdn = CloudFront("CloudFront\n(CDN, HTTPS)")

    with Cluster("AWS VPC (private subnets + NAT)"):
        alb = ElbApplicationLoadBalancer("ALB\n(SG: CloudFront prefix list only)")
        app = Fargate("Next.js Platform\n(ECS Fargate · UI + API)")

        with Cluster("Auth & Control Plane", graph_attr={"labeljust": "c", "labelloc": "b"}):
            cognito = Cognito("Cognito\n(project RBAC)")
            ddb = Dynamodb("DynamoDB\n(61 tables)")
            secrets = SecretsManager("Secrets\nManager")

        # ---- Data sources: 4 paradigms / 8 providers ----
        with Cluster("Data Sources — 4 paradigms / 8 providers"):
            jdbc = RDSMysqlInstance("JDBC ×4\n(MySQL/PG/Oracle/MSSQL)")
            src_s3 = S3("S3\n(object store)")
            src_ddb = Dynamodb("DynamoDB\n(NoSQL)")
            src_kinesis = Kinesis("Kinesis\n(stream)")
            src_msk = ManagedStreamingForKafka("MSK / Kafka\n(stream)")

        # ---- Ingestion: batch (Glue) + real-time CDC (DMS / Zero-ETL / Flink CDC) ----
        with Cluster("Ingestion", graph_attr={"margin": "44", "labelloc": "b", "labeljust": "c"}):
            glue = Glue("Glue ETL\n(batch)")
            dms = DMS("DMS (real-time)\n(CDC + Zero-ETL)")

        # ---- Lakehouse storage ----
        with Cluster("Lakehouse", graph_attr={"labelloc": "b", "margin": "24"}):
            s3t = S3("S3 Tables\n(Iceberg)")
            lake = S3("S3\nData Lake")
            rs = Redshift("Redshift\nServerless")

        # ---- Compute engines: pluggable SPI (Glue / EMR Serverless / Athena / Redshift / Flink) ----
        with Cluster("Compute\nEngines\n(pluggable\nSPI)", graph_attr={"margin": "48"}):
            emr = EMR("EMR Serverless\n(PySpark / SQL)")
            athena = Athena("Athena\n(Trino on S3 Tables)")
            flink = KinesisDataAnalytics("MSAF Flink\n(SQL streaming)")

        with Cluster("Orchestration", graph_attr={"labelloc": "b"}):
            mwaa = MWAA("MWAA\n(Airflow)")

        with Cluster("Governance —\nOpenMetadata"):
            om = Fargate("OpenMetadata\nServer (ECS)")
            omdb = RDSMysqlInstance("OM Metadata DB\n(MySQL)")
            omsearch = AmazonOpensearchService("OpenSearch")

    # AI plane: regional Bedrock + 3 AgentCore stacks (detailed in genai-architecture.png).
    with Cluster("AI Plane", graph_attr={"margin": "48"}):
        bedrock = Bedrock("Bedrock (Claude Opus)\n+ 3 AgentCore stacks")

    # ---- Request path ----
    users >> Edge(label="HTTPS") >> cdn >> alb >> app

    # ---- App -> control plane ----
    app >> Edge(color="darkgreen", style="dashed") >> cognito
    app >> Edge(color="darkgreen", style="dashed") >> ddb
    app >> Edge(color="darkgreen", style="dashed") >> secrets

    # ---- App drives ingestion / engines / orchestration / governance ----
    app >> Edge(color="darkblue") >> glue
    app >> Edge(color="darkblue") >> dms
    app >> Edge(color="darkblue") >> emr
    app >> Edge(color="darkblue") >> athena
    app >> Edge(color="darkblue") >> flink
    app >> Edge(color="darkblue") >> rs
    app >> Edge(color="darkblue") >> mwaa
    app >> Edge(color="purple", headlabel="catalog / lineage\n(via CloudFront)", labelfontcolor="purple", labeldistance="11", labelangle="95") >> om

    # ---- Sources -> ingestion (batch extract + CDC) ----
    jdbc >> Edge(color="gray") >> glue
    src_s3 >> Edge(color="gray", weight="5") >> glue
    src_ddb >> Edge(color="gray") >> glue
    jdbc >> Edge(color="firebrick", style="dashed", headlabel="CDC", labelfontcolor="firebrick", labeldistance="2.3", labelangle="-41") >> dms
    src_kinesis >> Edge(color="firebrick", style="dashed", headlabel="stream", labelfontcolor="firebrick", labeldistance="3.9", labelangle="-50") >> flink
    src_msk >> Edge(color="firebrick", style="dashed", headlabel="stream", labelfontcolor="firebrick", labeldistance="7.8", labelangle="-45") >> flink

    # ---- Ingestion -> lakehouse ----
    glue >> Edge(headlabel="load", labeldistance="3.2", labelangle="45") >> s3t
    glue >> Edge(taillabel="load", labeldistance="9.3", labelangle="-14", weight="5") >> rs
    glue >> lake
    dms >> Edge(taillabel="CDC apply", labeldistance="9.5", labelangle="-38") >> rs
    flink >> Edge(taillabel="sink", labeldistance="7.0", labelangle="18") >> s3t

    # ---- Compute engines read/write lakehouse ----
    emr >> Edge(style="dashed") >> s3t
    athena >> Edge(style="dashed") >> s3t
    rs >> Edge(style="dashed") >> s3t

    # ---- AI plane: app calls Bedrock/AgentCore; read-only over the lakehouse ----
    app >> Edge(color="orange", headlabel="GenBI / Copilot /\nadvisors", labeldistance="12", labelangle="-40") >> bedrock
    bedrock >> Edge(color="orange", style="dashed", taillabel="read-only SQL", labelfontcolor="darkorange", labeldistance="8", labelangle="45") >> rs
    bedrock >> Edge(color="orange", style="dashed", headlabel="read-only SQL", labelfontcolor="darkorange", labeldistance="9", labelangle="78") >> athena

    # ---- Governance backend ----
    om >> omdb
    om >> omsearch
