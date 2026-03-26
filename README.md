# MoyuDIT

面向摄影师的桌面导入工具。它负责把储存卡里的照片安全拷到电脑，按拍摄时间归档，支持评分筛选、双目标备份、导入校验、导入恢复和可视化导入报告。

## 定位

- 这是导入器，不是图库管理器。
- 优先保证“导得稳、校验清楚、目录整齐”。
- 工作流围绕 macOS / 桌面摄影导入场景设计。

## 主要功能

- 自动识别可移动卷和常见相机目录
- 读取素材并显示实时分析进度
- 按年份 / 年月 / 日期 / 日期 + 机型归档
- 按日期范围、已有星级、素材类型筛选导入
- 支持仅导入 `RAW`、仅导入 `JPEG`、或 `RAW + JPEG` 成对素材
- 双目标导入，可同时写入主目录和备份目录
- 导入时执行 `MD5` / `BLAKE3` 校验
- 导入失败原因分类显示
- 支持导入中取消与下次恢复
- 缩略图预览、单张放大预览、临时打星和纳入/排除
- 导入预设、本地历史记录、重复导入提醒
- 导出可视化 PDF 报告

## macOS 安装

当前提供的安装包：

- [Photo Ingest Studio_0.1.0_aarch64_fixed.dmg](./src-tauri/target/release/bundle/dmg/Photo%20Ingest%20Studio_0.1.0_aarch64_fixed.dmg)

安装方式：

1. 打开 `dmg`
2. 将 `Photo Ingest Studio.app` 拖到 `Applications`
3. 首次运行如果被系统拦截，到“系统设置 > 隐私与安全性”里放行

说明：

- 当前安装包是未签名版本，适合自用测试
- Apple Silicon 机器优先使用当前 `aarch64` 安装包

## 开发环境

### 依赖

- Node.js 20+
- Rust / Cargo
- 推荐安装 `ExifTool`

macOS:

```bash
brew install exiftool
```

### 启动

安装依赖：

```bash
npm install
```

启动桌面开发版：

```bash
npm run tauri dev
```

只启动前端预览：

```bash
npm run dev
```

## 打包

生成 macOS 安装包：

```bash
npm exec tauri -- build --bundles dmg
```

如果 Tauri 自带的 `dmg` 美化脚本在本机环境下失败，当前仓库也可以用 `hdiutil create` 从已生成的 `.app` 手工封装安装包。

## 项目结构

```text
.
├── docs/
├── src/
│   ├── App.tsx
│   ├── api.ts
│   ├── styles/
│   └── types.ts
├── src-tauri/
│   ├── icons/
│   ├── src/
│   │   ├── commands.rs
│   │   ├── lib.rs
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
└── README.md
```

## 当前版本

`v0.1.0`

包含：

- macOS 图标与安装包
- 导入崩溃修复
- 完整导入主链路
- 预览、筛选、恢复、报告与历史

## 备注

界面标题：`摄影导入台`  
署名字样：`摸鱼开发`
