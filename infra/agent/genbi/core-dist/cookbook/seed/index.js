"use strict";
// 模块 45 — 系统内嵌配方基座(代码内嵌、随平台分发、只读)。
// 汇总各引擎的系统配方 + 方言规则。普通用户/管理员都改不了源码 = 天然只读基座。
// 加系统能力 = 对应引擎文件加配方 + 这里 import 汇总一行(开发者动作,需重部署)。
//
// 入库纪律(见 docs/design/45 §6):系统配方【必须验证过才入库】——真跑确认(Glue job/redshift-data API),
// 记 verifiedAt,绝不倒大模型记忆/幻觉(否则把错误编码进平台更危险)。
//
// 与【管理员动态配方】(store.ts, DynamoDB)的关系:registry 合并两者(系统基座 + 管理员扩展),
// 系统配方永远在、不可删;管理员只能在其上【新增】企业特有范式(带 isPlatformAdmin 鉴权)。
// 方言规则(DialectRule)只来自系统内嵌——方言是引擎客观事实,不开放给管理员改(避免误配把 guard 搞坏)。
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_DIALECT_RULES = exports.SYSTEM_RECIPES = void 0;
const redshift_1 = require("./redshift");
const s3tables_1 = require("./s3tables");
const glue_1 = require("./glue");
const emr_1 = require("./emr");
const flink_1 = require("./flink");
const sync_1 = require("./sync");
const athena_1 = require("./athena");
// ← 加引擎能力:对应文件加配方,再在这两个数组各 import 一段。
exports.SYSTEM_RECIPES = [
    ...redshift_1.REDSHIFT_RECIPES,
    ...s3tables_1.S3TABLES_RECIPES,
    ...glue_1.GLUE_RECIPES,
    ...emr_1.EMR_RECIPES,
    ...flink_1.FLINK_RECIPES,
    ...sync_1.SYNC_RECIPES,
    ...athena_1.ATHENA_RECIPES,
];
exports.SYSTEM_DIALECT_RULES = [
    ...redshift_1.REDSHIFT_DIALECT_RULES,
    ...s3tables_1.S3TABLES_DIALECT_RULES,
    ...glue_1.GLUE_DIALECT_RULES,
    ...emr_1.EMR_DIALECT_RULES,
    ...flink_1.FLINK_DIALECT_RULES,
    ...sync_1.SYNC_DIALECT_RULES,
    ...athena_1.ATHENA_DIALECT_RULES,
];
