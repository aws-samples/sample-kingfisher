// 系统内嵌配方基座(代码内嵌、随平台分发、只读)。
// 汇总各引擎的系统配方 + 方言规则。普通用户/管理员都改不了源码 = 天然只读基座。
// 加系统能力 = 对应引擎文件加配方 + 这里 import 汇总一行(开发者动作,需重部署)。
//
// 入库纪律(见 docs/design/45 §6):系统配方【必须验证过才入库】——真跑确认(Glue job/redshift-data API),
// 记 verifiedAt,绝不倒大模型记忆/幻觉(否则把错误编码进平台更危险)。
//
// 与【管理员动态配方】(store.ts, DynamoDB)的关系:registry 合并两者(系统基座 + 管理员扩展),
// 系统配方永远在、不可删;管理员只能在其上【新增】企业特有范式(带 isPlatformAdmin 鉴权)。
// 方言规则(DialectRule)只来自系统内嵌——方言是引擎客观事实,不开放给管理员改(避免误配把 guard 搞坏)。

import type { DialectRule, Recipe } from "../types";
import { REDSHIFT_DIALECT_RULES, REDSHIFT_RECIPES } from "./redshift";
import { S3TABLES_DIALECT_RULES, S3TABLES_RECIPES } from "./s3tables";
import { GLUE_DIALECT_RULES, GLUE_RECIPES } from "./glue";
import { EMR_DIALECT_RULES, EMR_RECIPES } from "./emr";
import { FLINK_DIALECT_RULES, FLINK_RECIPES } from "./flink";
import { SYNC_DIALECT_RULES, SYNC_RECIPES } from "./sync";
import { ATHENA_DIALECT_RULES, ATHENA_RECIPES } from "./athena";

// ← 加引擎能力:对应文件加配方,再在这两个数组各 import 一段。
export const SYSTEM_RECIPES: Recipe[] = [
  ...REDSHIFT_RECIPES,
  ...S3TABLES_RECIPES,
  ...GLUE_RECIPES,
  ...EMR_RECIPES,
  ...FLINK_RECIPES,
  ...SYNC_RECIPES,
  ...ATHENA_RECIPES,
];

export const SYSTEM_DIALECT_RULES: DialectRule[] = [
  ...REDSHIFT_DIALECT_RULES,
  ...S3TABLES_DIALECT_RULES,
  ...GLUE_DIALECT_RULES,
  ...EMR_DIALECT_RULES,
  ...FLINK_DIALECT_RULES,
  ...SYNC_DIALECT_RULES,
  ...ATHENA_DIALECT_RULES,
];
