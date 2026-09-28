# dsh-auto-archive

DSH 会话**自动归档**插件 —— 在原 [dsh-archived-sessions](https://github.com/MuWinds/dsh-archived-sessions)（归档会话管理）基础上加入后台自动归档引擎，按闲置时长把冷会话自动移入归档区。

在 Harness 的「设置 → 归档会话」页面提供：

## 自动归档（新增）

- **闲置阈值**：会话文件超过 N 天未写入（默认 14 天）即自动归档；mtime 取会话目录内所有代际日志（`session.jsonl.zstd` / `session.v3.jsonl.zstd` 等）的最新写入时间
  - ⚠️ **闲置 = 最后活跃时间（日志最后写入），不是会话创建时间**。侧边栏列表显示的是创建时间，一个「17 天前」的会话如果几天前还有活动（如「继续会话」派生写入），实际并未闲置满阈值，不会被归档。设置面板的会话清单同时显示两个口径（「创建 X 天前 · 闲置 Y 天」）
- **后台定时扫描**：默认每天 1 次（可调 0.25–365 天），Harness 启动 3 分钟后跑首轮；扫描不重叠
- **安全护栏**（自动归档只碰完全冷掉的会话）：
  - 正在运行回合的会话永不触碰
  - 仍驻留内存（live）的会话一律跳过，哪怕文件已安静多日
  - **置顶会话（侧边栏钉住）永不自动归档**
  - 手动排除清单（`excludeIds`）里的会话永不自动归档
  - 已在归档区的会话天然幂等跳过
- **归档通道**：优先走官方 `workspaceRegistry.archiveSession()`，异常时降级为 storage 域直写 + 私有缓存同步（与 dsh-session-manager 同一套兜底）
- **设置卡片**：开关 / 阈值 / 周期编辑、立即扫描（仅预览）、立即扫描并归档（二次确认）、最近一次扫描审计与待归档预览列表
- **手动归档**：会话清单逐个「归档」/「永不自动归档」（排除清单 UI 化），无需等闲置阈值

## 附件清理（v0.4.0 新增）

会话里粘贴/拖入的图片和文件原件存于 `<harness-home>/attachments/v1/objects`（按 sha256 分片），日积月累可达上百 MB。本插件把它和归档状态联动起来：

- **扫描**：解压所有**未归档**（含活跃）会话日志，建立附件引用索引；「未被任何未归档会话引用」的附件 = 只被已归档会话或已删除会话使用 → 列为可清理
- **跨平台**：引用匹配按附件的 sha256 文件名（与路径分隔符无关），Windows 反斜杠路径同样命中；匹配刻意宽松——宁可少清、绝不误删
- **安全**：扫描手动触发（数百会话约 5–20 秒），不做任何自动删除；清理需两步确认且不可逆；逐文件删除，单个失败（如 Windows 上文件被杀毒/索引短暂占用）不中断整批
- 仅处理 `objects/` 下的 sha 命名文件，`request-images/`、`tmp/` 等一概不动

## 归档会话管理（继承自原插件）

- 查看所有已归档会话（标题、创建时间、所属目录、磁盘路径、占用空间）
- 释放（取消归档）—— 单个、批量、一键全部
- 从硬盘删除 —— 单个、批量、一键清空（两步确认）
- 点击标题展开预览会话内容（用户 / 助手 / 工具消息）

> ⚠️ **安全提示**：本插件包含「从硬盘删除会话文件」能力，删除不可恢复。自动归档只做归档（可逆），删除始终需要手动触发。安装前请自行审阅源码。

## 状态持久化

配置与最近一次扫描审计存于 harness 根目录的 `dsh-auto-archive.json`（根目录由会话产物路径自动推导，如
`~/Library/Application Support/dsh-desktop/harness/dsh-auto-archive.json`），原子写入，可直接手工编辑后重启。

## 安装（本地 link 方式）

```sh
# 1. profile 依赖加入本地链接
cd ~/Library/Application\ Support/dsh-desktop/harness/profiles/web
pnpm add "link:/path/to/dsh-auto-archive"

# 2. 重启 DSH，设置面板出现「归档会话」页与「自动归档」卡片
```

或从 GitHub 安装（推荐，克隆后 link）：

```sh
# 1. 克隆仓库到本地任意位置
git clone https://github.com/wzn16/dsh-auto-archive.git

# 2. profile 依赖加入本地链接（路径换成你自己的克隆位置）
cd ~/Library/Application\ Support/dsh-desktop/harness/profiles/web
pnpm add "link:/path/to/dsh-auto-archive"

# 3. 重启 DSH，设置面板出现「归档会话」页与「自动归档」卡片
```

## 开发

```sh
npm install        # typescript 等构建依赖（运行时零外部依赖）
npm run build      # tsc 宿主 + tsc client + ModuleLoader 包装
npm run typecheck
```

源码结构：

- `src/auto-archive.ts` — 自动归档引擎：配置持久化、扫描/归档、调度器
- `src/index.ts` — 宿主半：`/dsh-archived/*` JSON API（list/unarchive/delete/detail + auto-status/auto-config-set/auto-scan）、路由注册、调度器生命周期
- `src/client.tsx` — Web 设置页：自动归档卡片 + 归档会话管理表格

## 致谢与许可

归档管理部分基于 MuWinds 的 dsh-archived-sessions（MIT）改写；自动归档引擎与降级归档逻辑参考了 dsh-session-manager 对 registry 缓存一致性的处理经验。本项目 MIT。
