import type { Metadata } from "next";
import "./globals.css";
import RootLayoutClient from "./layoutClient";
import { earlySkinScript } from "@/lib/skins/ThemeProvider";

export const metadata: Metadata = {
  title: "Kingfisher",
  description: "Kingfisher · 大数据开发治理平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        {/* 换肤:React 之前先按已存皮肤预刷 body 背景,消除首帧闪动(默认皮肤无影响)。 */}
        <script dangerouslySetInnerHTML={{ __html: earlySkinScript }} />
      </head>
      <body>
        <RootLayoutClient>{children}</RootLayoutClient>
      </body>
    </html>
  );
}
