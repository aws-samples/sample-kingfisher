// 换肤早期脚本 —— 放在 <head> 的内联脚本,在 React 之前执行:从 localStorage 读已存皮肤并预刷 body 背景,
// 消除「已切换非默认皮肤的用户」刷新时的一帧默认色闪动。只做背景色,轻量安全。
//
// 🔴 本文件**不许**加 "use client",也不许从带 "use client" 的模块取值:
//   根布局(app/layout.tsx)是服务端组件,它把这段脚本的文本写进 <head>。服务端组件从客户端模块导入一个**值**
//   (不是当组件用)时,拿到的是「客户端引用」而不是文本本身 —— 浏览器端要等那个客户端模块的分片全部到齐才能解析出这段文本,
//   于是 <head> 里的 <script> 在浏览器端成了一个延迟解析的元素。分片恰在水合 <head> 的那一刻到齐时,React 会把 <head> 重放一遍,
//   水合游标留在 <head> 里回不到 <body>,<body> 里第一个要认领的节点失配 ⇒ 页面级报错「水合不一致」,整棵页面树在浏览器重建一次。
//   2026-11-14 两个测试环境页面探针坐实:全新浏览器会话首开任意页面间歇出现(同一会话后续页面分片已缓存,不出现)。
//   所以:存储键与这段脚本定义在这里(普通模块,服务端 / 浏览器两侧都能直接求值),换肤提供者从这里取存储键。
import { SKINS, skinBodyBackground, skinBodyBackgroundSize } from "./skins";

/** 已选皮肤 id 在 localStorage 里的键(换肤提供者读写、早期脚本读,同一个)。 */
export const SKIN_STORAGE_KEY = "bgp-skin";

export const earlySkinScript = `(function(){try{
  var id=localStorage.getItem(${JSON.stringify(SKIN_STORAGE_KEY)});
  if(!id)return;
  var m=${JSON.stringify(
    SKINS.reduce((acc, s) => {
      acc[s.id] = { bg: skinBodyBackground(s), size: skinBodyBackgroundSize(s), text: s.text };
      return acc;
    }, {} as Record<string, { bg: string; size: string; text: string }>),
  )};
  var s=m[id]; if(!s)return;
  var b=document.body||document.documentElement;
  document.documentElement.setAttribute('data-skin',id);
  if(document.body){document.body.style.background=s.bg;document.body.style.backgroundSize=s.size;document.body.style.backgroundAttachment='fixed';document.body.style.color=s.text;}
}catch(e){}})();`;
