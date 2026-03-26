# Photo Ingest Studio

面向摄影师的跨平台桌面导入工具原型。定位是“安全导入器”，不是图库管理器。它负责把储存卡中的照片批量拷贝到电脑，按拍摄时间归档，按已有星级筛选，并在导入时执行哈希校验。

## 当前状态

这个仓库当前包含：

- `React + Vite` 的摄影导入流程前端
- `Tauri + Rust` 的扫描、预演、导入后端

当前机器已经安装了 `Rust` / `Cargo`，可以继续把 Tauri 后端实现接完整。

## 功能目标

- 选择储存卡或导入源目录
- 扫描 JPG / RAW 文件
- 读取 EXIF 拍摄时间
- 按日期或日期 + 机型归档
- 根据已有星级筛选导入文件
- 导入时执行 MD5 / BLAKE3 校验
- 导入结果写入 SQLite 历史记录
- 重复文件检测和跳过策略

## 目录结构

```text
.
├── docs/
│   └── architecture.md
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── api.ts
│   ├── styles/
│   └── types.ts
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── commands.rs
│       ├── lib.rs
│       └── main.rs
├── index.html
├── package.json
└── vite.config.ts
```

## 建议开发路线

### 第 1 阶段：完成安全导入主链路

- 选择来源目录或储存卡
- 分析卡内图片
- 生成导入计划
- 执行拷贝
- 计算并比对哈希

### 第 2 阶段：补齐摄影工作流

- 只导入已有评级照片
- XMP sidecar 写入
- 重复导入检测
- 导入历史与失败重试

### 第 3 阶段：提升效率

- 缩略图缓存
- 多线程导入
- 断点续导
- 同步双目标磁盘

## 环境安装

### 1. 安装 Rust

macOS:

```bash
brew install rust
```

Windows:

安装 [Rustup](https://rustup.rs/)

### 2. 安装前端依赖

```bash
npm install
```

### 3. 可选安装 ExifTool

推荐安装，用来读取 RAW/JPG 的拍摄时间、机型、评级元数据。

macOS:

```bash
brew install exiftool
```

Windows:

安装 [ExifTool](https://exiftool.org/)

### 4. 启动开发环境

前端预览：

```bash
npm run dev
```

Tauri 桌面版：

```bash
npm run tauri dev
```

## 当前交互流程

现在的界面按下面 4 步组织：

1. 选择来源
2. 分析素材
3. 确认导入方案
4. 开始导入

也就是说，用户不需要先理解很多技术参数，再开始导入。

## 后续需要优先实现的后端命令

- `scan_card`
- `preview_import`
- `run_import`

这三个命令已经在 [src-tauri/src/commands.rs](/Users/moyumahiru/Documents/dit/src-tauri/src/commands.rs) 里有可继续扩展的实现：

- `scan_card`：扫描目录并识别支持的照片格式
- `preview_import`：按模板预演目标路径
- `run_import`：执行复制、重复处理和哈希校验

当前如果系统没安装 `ExifTool`，会自动回退到文件修改时间，不会阻塞导入流程。
