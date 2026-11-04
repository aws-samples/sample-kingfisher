// 模块 44 → 45 迁移兼容层。管理员动态配方存储已迁入 lib/cookbook/store(复用同一 DynamoDB 表)。
// 保留旧 import 兼容(cookbook recipes API 的 CRUD)。写操作后应调 bustAdminCache 失效缓存(见调用方)。
// 新代码请直接从 @/lib/cookbook 导入。

export {
  listAdminRecipes,
  listAllAdminRecipes,
  createAdminRecipe,
  deleteAdminRecipe,
  type AdminRecipeRow,
} from "@/lib/cookbook/store";
