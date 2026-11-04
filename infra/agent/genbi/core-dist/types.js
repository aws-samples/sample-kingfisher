"use strict";
// @genbi/core — 引擎无关的核心类型单一来源。
//
// 【core 契约】core 内部所有文件引用类型都走 "./types"（相对路径,不用 @/ alias,
// 保证阶段2/3 编译成独立 CJS 给容器/Lambda 时无 alias 解析问题）。
//
// 两类类型:
//  1) core 私有类型(SchemaTable/CatalogEntry/ContextEntry 等)——定义在此,core 独有。
//  2) 跨 core 边界的全局契约类型(ChartSpec/GenBiStep 等)——【阶段2 已物理下沉至此】,
//     作为契约单一来源;@/types/genbi 反向 re-export 保持消费方路径不变。
//     下沉理由:core 须能独立编译成 CJS 给 Lambda/容器,不能靠 @/ alias。
Object.defineProperty(exports, "__esModule", { value: true });
