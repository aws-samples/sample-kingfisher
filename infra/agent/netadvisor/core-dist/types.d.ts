export type ComputeKind = "glue" | "dms" | "flink" | "zeroetl" | "lambda-vpc" | "emr" | "generic";
export type AwsServiceName = "s3" | "s3tables" | "dynamodb" | "kinesis" | "secretsmanager" | "kms" | "glue" | "sts" | "logs" | "redshift-data" | "athena" | "bedrock";
export type Target = {
    kind: "datasource";
    datasourceId: string;
    port?: number;
} | {
    kind: "rds";
    instanceId?: string;
    endpoint?: string;
    port?: number;
} | {
    kind: "aurora";
    clusterId: string;
    role?: "writer" | "reader";
    port?: number;
} | {
    kind: "redshift";
    flavor: "provisioned" | "serverless";
    identifier: string;
    port?: number;
} | {
    kind: "aws-service";
    service: AwsServiceName;
} | {
    kind: "msk";
    clusterArn: string;
    auth?: "iam" | "sasl-scram" | "tls" | "plaintext";
} | {
    kind: "opensearch";
    domainOrEndpoint: string;
    port?: number;
} | {
    kind: "host";
    host: string;
    port: number;
    tls?: boolean;
} | {
    kind: "external";
    host: string;
    port: number;
    vendor?: "snowflake" | "bigquery" | "other";
};
export type RuleStatus = "PASS" | "FAIL" | "UNKNOWN";
export type RemediationType = "create-sg" | "add-sg-self-ref" | "add-sg-egress-to-target" | "add-source-ingress-from-sg" | "replace-cidr-rule-with-sgref" | "create-s3-gateway-endpoint" | "create-interface-endpoint" | "enable-dns-attributes" | "add-route-to-target-cidr" | "add-nat-or-endpoint" | "pick-subnet-in-target-az" | "widen-endpoint-policy" | "open-nacl" | "request-cross-account-access" | "set-zeroetl-resource-policy" | "enable-binlog" | "manual";
export interface RuleDef {
    id: string;
    title: string;
    statement: string;
    awsCitation: string;
    severity: "hard" | "soft";
    remediationType: RemediationType;
    appliesToCompute?: ComputeKind[];
}
