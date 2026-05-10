# HyperFrames Project Dashboard

一个本地网页 Dashboard，用来统一管理一整个文件夹里的 HyperFrames 项目。

[English README](README.md)

## 为什么做这个

HyperFrames 自带的 `hyperframes preview` 很适合单个项目，但当项目变多以后，会出现几个很实际的问题：

- 不知道哪个项目正在运行预览。
- 不想反复进终端启动、停止不同项目。
- render、缩略图、项目文件夹分散在不同目录里，不好快速定位。
- 旧项目清理麻烦，误删风险也高。

这个 Dashboard 的目标很简单：把一个父目录下的所有 HyperFrames 项目放到一个本地网页里管理。

## 截图

![Dashboard 总览](docs/screenshots/dashboard.png)

![Render 设置](docs/screenshots/render-settings.png)

## 主要功能

- 扫描一个父目录下的所有 HyperFrames 项目。
- 默认按“正在运行优先 + 新到旧”排序。
- 支持搜索、Active only、网格视图和竖列卡片视图。
- 每个项目可以直接 Start、Stop、Open Studio、Open Folder、Open Render。
- 顶部支持一键 Stop all，关闭当前 root 下所有正在运行的 preview。
- 显示缩略图、项目名、状态、分辨率、时长、composition 数、media 数、最新 render。
- 支持生成或刷新缩略图。
- 支持单个删除和多选批量删除。
- 删除会移动到系统 Trash / Recycle Bin，而不是永久删除。
- 卡片上可以直接 Render 视频。
- 默认导出 MP4 + HEVC，也可以在 Render Settings 里调整格式、质量、FPS、分辨率、workers、GPU、CRF、bitrate 等。

## 安装和运行

需要：

- Node.js 20 或更新版本。
- 可以通过 `npx hyperframes` 使用 HyperFrames CLI。
- 安装 `ffmpeg`，用于从视频抽缩略图和转 HEVC。

运行：

```bash
npm install
npm start -- --root /path/to/your/HyperFrames/projects
```

如果你的项目父目录就是 `~/Desktop/Hyperframes`，直接用：

```bash
cd ~/Desktop/hyperframes-project-dashboard
npm start -- --root ~/Desktop/Hyperframes
```

也可以本地 link 后用短命令：

```bash
npm link
hf-dashboard --root /path/to/your/HyperFrames/projects
```

启动后打开终端打印的本地地址，通常是：

```text
http://localhost:4599
```

## 项目目录要求

选择的 root 应该是一个父目录，里面每个一层子目录都是一个 HyperFrames 项目：

```text
Hyperframes/
  project-a/
    index.html
  project-b/
    index.html
```

Dashboard 会检查子目录里是否存在 `index.html`。

## Render 说明

默认设置：

- Format: MP4
- Codec: HEVC
- Quality: Standard
- FPS: 30

HEVC 是两步完成的：

1. 先用 `npx hyperframes render` 导出原生 MP4。
2. 再用 `ffmpeg` 转成 HEVC，并写入 `hvc1` tag。

macOS 上会优先尝试 `hevc_videotoolbox`，失败后回退到 `libx265`。其他平台默认走 `libx265`。

## 安全说明

- 这个工具只绑定在 `127.0.0.1`，用于本地开发。
- 单项目删除需要输入项目名确认。
- 批量删除需要输入 `DELETE` 确认。
- Render job 状态只保存在当前 dashboard 进程内；导出的视频文件会保留在项目的 `renders/` 文件夹里。

## License

MIT
