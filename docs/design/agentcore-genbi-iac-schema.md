# AgentCore CloudFormation resource schema quick reference (verified LIVE in the test account in us-east-1, 2026-06-15)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written in the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. Multi-region behavior — place, execution scope, per-region scheduling and the like — is described in the [multi-region execution specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index; a path mentioned below that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Used for the CDK `CfnResource` escape hatch. All resource types `AWS::BedrockAgentCore::*` are LIVE in us-east-1 in the test account.

## AWS::BedrockAgentCore::Gateway
- required: `Name`, `RoleArn`, `AuthorizerType`
- `AuthorizerType` ∈ {CUSTOM_JWT, **AWS_IAM**, NONE, AUTHENTICATE_ONLY} → use **AWS_IAM** (inbound SigV4, no OAuth/Cognito needed). With AWS_IAM no AuthorizerConfiguration is required.
- `ProtocolType`: "MCP" (default). `ProtocolConfiguration`: `{ Mcp: { SupportedVersions:["2025-03-26"], Instructions?, SearchType? } }` (all optional).
- `RoleArn`: the Gateway's outbound role (assumed by the gateway to invoke the target Lambda).
- Output attributes: `GatewayUrl` (the MCP endpoint), `GatewayArn`, `GatewayIdentifier`.
- CustomJWT alternative: `AuthorizerConfiguration.CustomJWTAuthorizer={DiscoveryUrl, AllowedClients[], AllowedAudience[]}` (`DiscoveryUrl` must end in `.../.well-known/openid-configuration`).

## AWS::BedrockAgentCore::GatewayTarget
- required: `Name`, `TargetConfiguration`
- createOnly: `GatewayIdentifier` (binds the target to a Gateway)
- `TargetConfiguration.Mcp.Lambda = { LambdaArn, ToolSchema }`
- `ToolSchema = { InlinePayload: [ ToolDefinition... ] }` (or `{ S3: {...} }`)
- `ToolDefinition = { Name, Description, InputSchema, OutputSchema? }` (required: Name/Description/InputSchema)
- `SchemaDefinition = { Type:("string"|"number"|"object"|"array"|"boolean"|"integer"), Properties:{name:SchemaDefinition}, Required:[..], Items:SchemaDefinition, Description }`
- `CredentialProviderConfigurations: [ { CredentialProviderType: "GATEWAY_IAM_ROLE" } ]` (Lambda target → the gateway invokes the Lambda with its own role). enum: GATEWAY_IAM_ROLE/OAUTH/API_KEY/CALLER_IAM_CREDENTIALS/JWT_PASSTHROUGH.

## AWS::BedrockAgentCore::Runtime
- required: `AgentRuntimeName`, `AgentRuntimeArtifact`, `RoleArn`, `NetworkConfiguration`
- `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri` (ECR image, ARM64)
- `NetworkConfiguration.NetworkMode`: "PUBLIC" (or VPC + NetworkModeConfig{SecurityGroups,Subnets})
- `ProtocolConfiguration`: "HTTP" (the /invocations contract; MCP/A2A/AGUI are also possible)
- `EnvironmentVariables`: { K:V } injected into the container (for example GATEWAY_URL/AWS_REGION/BEDROCK_MODEL_ID)
- createOnly: `AgentRuntimeName`. Outputs: `AgentRuntimeArn`, `AgentRuntimeId`.
- `AuthorizerConfiguration` (optional, inbound JWT); not needed when the platform invokes the Runtime through the SDK with IAM.

## AWS::BedrockAgentCore::RuntimeEndpoint
- required: `AgentRuntimeId`, `Name` (both createOnly). Optional `AgentRuntimeVersion`/`TargetVersion`. The default endpoint qualifier is DEFAULT.

## Lambda target event contract (gateway→lambda)
- When the Gateway invokes the Lambda, the tool name is in `context.client_context.custom["bedrockAgentCoreToolName"]` (of the form `<targetName>___<toolName>`), and the input is the event (JSON matching ToolDefinition.InputSchema). The JSON result the Lambda returns is the tool output.

## Control plane / data plane
- Control-plane service: `bedrock-agentcore-control` (create-gateway/create-gateway-target/create-agent-runtime/...).
- Data-plane service: `bedrock-agentcore` (invoke_agent_runtime(agentRuntimeArn, runtimeSessionId≥33, payload, qualifier)).
