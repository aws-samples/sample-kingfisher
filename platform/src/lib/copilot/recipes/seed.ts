// → 45 迁移兼容层。系统内嵌配方基座已迁入 lib/cookbook/seed。
// 保留旧 import 兼容(cookbook recipes API 从这里拿 SYSTEM_RECIPES)。新代码请从 @/lib/cookbook 导入。

export { SYSTEM_RECIPES, SYSTEM_DIALECT_RULES } from "@/lib/cookbook/seed";
