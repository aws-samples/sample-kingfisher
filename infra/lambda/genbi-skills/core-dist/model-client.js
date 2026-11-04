"use strict";
// @genbi/core — 引擎无关的模型调用抽象（可插拔接口）。
//
// 【为什么存在】core 的检索/循环等逻辑需要调用大模型,但"怎么调"(直连 Bedrock SDK /
// 走 AgentCore MCP / 测试用 fake)是运行时耦合。把它抽成 ModelClient 接口注入,core 本身
// 保持零 AWS SDK 依赖,可被 platform(直连 Bedrock)、容器(直连/MCP)、单测(fake)复用。
//
// 阶段1:只有 retrieval 的重排序调用走此接口;agent.ts 主 Converse 循环阶段3 才抽(那才是
// 容器要复用的核心循环)。
Object.defineProperty(exports, "__esModule", { value: true });
