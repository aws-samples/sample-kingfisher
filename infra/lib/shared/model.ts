// 平台 AI 默认模型 —— 部署期侧出口(SSOT re-export)。
//
// 唯一真源是 repo 根 `ai-model.json`(见其 $comment)。本文件是它在【部署期侧(infra/CDK)】的出口:
// 三个 AgentCore 栈 + 平台栈把 DEFAULT_MODEL_ID 作为 Runtime/Lambda 的 BEDROCK_MODEL_ID 默认值注入。
//
// 为什么 readFileSync 而非 import json:infra 的 tsconfig rootDir="." 会拒绝 import 根目录之外的
// 文件(TS6059)。infra 经 ts-node 直跑(cdk.json),__dirname 指向源码目录,readFileSync 不受 rootDir
// 约束——与本目录已有的 path.join(__dirname, "..", ...) 定位 platform/ 的先例同法。
// 运行时侧(platform)另有 platform/src/lib/ai/model.ts 读同一 json(import,bundler 内联),
// 二者跨构建边界物理隔离,但同源同值。
import { readFileSync } from "fs";
import * as path from "path";

// json 在 platform/(而非 repo 根):须与 platform Docker 构建上下文一致(见 platform 侧 model.ts 说明)。
// infra/lib/shared → ../../../platform/ai-model.json。
const cfg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "..", "platform", "ai-model.json"), "utf-8"),
) as { defaultModelId: string; candidateModelIds?: string[] };

/** 平台默认大模型 id(唯一真源 ai-model.json)。 */
export const DEFAULT_MODEL_ID: string = cfg.defaultModelId;

/**
 * @kf-batch 51-v2-multi-vendor —— 部署期候选链(51 SPEC §7.7):部署脚本 `scripts/resolve-home-model.sh` 按它逐个展开
 * 本区推理配置并真 converse,第一个通的注入 BEDROCK_MODEL_ID。旧 json 没有 `candidateModelIds` ⇒ 退回 `[defaultModelId]`(向后兼容)。
 */
export const CANDIDATE_MODEL_IDS: readonly string[] =
  Array.isArray(cfg.candidateModelIds) && cfg.candidateModelIds.length > 0 ? cfg.candidateModelIds : [cfg.defaultModelId];

/** 解析生效的 modelId:env 覆盖优先,否则用 SSOT 默认值。CDK 栈注入 Runtime env 时用此。 */
export const resolveModelId = (explicit?: string): string =>
  explicit || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;

// @kf-batch 50-PROD-A-launch-hardening(h)
// 🔴 主控区自选后,出厂默认 `us.*`(美国跨区推理配置)在欧洲 / 亚太主控区**调不通**。部署脚本会按账号真值
//   选好再经 env BEDROCK_MODEL_ID 注入(scripts/resolve-home-model.sh);这里兜「裸 cdk deploy」:
//   地理前缀与主控区**明确不匹配**就当场拒(只拒确定错的三种;其余前缀 / 基础 id 交给部署期真调用判)。
const GEO_REGION_FAMILY: Record<string, string> = { "us.": "us-", "eu.": "eu-", "apac.": "ap-" };
export function modelRegionMismatch(modelId: string, region: string): string | null {
  const m = modelId.match(/^([a-z]+)\./);
  const fam = m ? GEO_REGION_FAMILY[`${m[1]}.`] : undefined;
  if (!fam || region.startsWith(fam)) return null;
  return (
    `默认大模型 ${modelId} 是「${m![1]}.」地理推理配置,主控区 ${region} 调不通。` +
    `请经部署脚本部署(它按账号真值选型),或设 BEDROCK_MODEL_ID=<该区可用的 id>(先跑 scripts/resolve-home-model.sh <profile> ${region})。`
  );
}
