# Personal AI Assistant

> 一个 Windows 优先、本地运行、由用户掌握最终决定权的个人任务与成长助手。

Personal AI Assistant 不只是任务清单。它把“今天准备做什么”连接到排期、专注、复盘、成长和健康参考，同时让 AI 始终停留在候选、整理和回应的位置：**任何计划变更都必须由用户确认。**

当前版本：`0.1.22` · 单用户 · Windows 优先 · Local-first

## 它能做什么

### 今天：把任务真正放进一天

- 上午、下午、晚上以层叠时间页展示，当前时间页始终处于最前方。
- 已排期任务与未排期任务分开管理。
- 未排期任务可拖入完整时间轴，形成明确的开始和结束时间。
- 时间冲突不会静默覆盖；调整计划仍需用户确认。
- 想法、问题、正式任务和补录记录保持独立。

### 专注：从准备到评价的完整闭环

- 固定任务开始前一分钟出现准备窗口。
- 用户明确确认后才进入专注；专注阶段不能暂停或取消。
- 专注窗口独立存在，可隐藏、置顶或固定在屏幕角落。
- 支持连续专注、段内休息、末段可跳过休息和最终评价。
- 五套计时主题：水墨册页、素简翻页、辉光电子管、蒸汽波、赛博终端。
- 桌面弹窗、评价、飞书卡片和提示可以分别关闭；全部关闭时也可把应用当作安静的备忘录。

### AI：帮助整理，但不替用户做决定

- 用自然语言整理任务、想法和问题候选。
- 从长期计划生成可编辑的任务树候选。
- 对冲突或计划变化给出建议，但不会自动改动时间表。
- 在复盘和健康页面保留可恢复的对话记录。
- AI 失败时保留用户原始输入，不伪造结果，也不写入错误候选。

### 复盘、日记与成长

- 保存用户自己的每日复盘，并可选择请求 AI 回应。
- 在本地保留复盘与日记素材；当前公开版本不启用 Agent 联网搜索、独立每日简报或 Work Buddy 简报导入。
- 保存赛博日记及其来源快照，后续编辑不会偷偷重算历史。
- 六维回看采用五层六边形阶段刻度，只能落在 `20 / 40 / 60 / 80 / 100` 五档顶点。
- 成长页通过真实任务、专注和反馈呈现趋势、竹子阶段与情绪痕迹。

### 健康参考

- 以“周笺 + 日处方”组织饮食、饮水、运动和安全提醒。
- AI 生成内容先成为候选，确认后才成为当周参考。
- 健康建议不会自动创建或更改任务。
- 支持可选的睡眠截图分析；没有可用视觉模型时会明确提示不可用。

### 个性化与数据控制

- 统一设置计时主题、窗口位置、通知、飞书卡片、健康页和评价流程。
- 本地逻辑备份由用户主动下载，不包含 API Key 或数据库密码。
- 回收站支持保留期限和一键清空。
- 没有公开注册、社交、监控、人格推断或惩罚机制。

## 隐私与安全边界

- 应用是本地优先、单用户结构；API、Worker 和 PostgreSQL 均运行在用户自己的电脑上。
- DeepSeek、视觉模型和飞书凭据只允许写入本地配置文件。
- 浏览器前端、公开仓库、安装包、截图和备份中都不应出现真实密钥。
- 桌面安装包只包含无密钥的 `.env.example`；首次启动后才在用户目录创建私有 `.env`。
- `.env`、数据库文件、日志、备份、测试输出和安装包构建目录均被 Git 忽略。

发现凭据泄露时，请先撤销或轮换凭据，再处理 Git 历史。完整边界见 [SECURITY.md](SECURITY.md)。

## 普通用户从零开始

目前发布版需要：

- Windows 10/11 x64；
- PostgreSQL 18.x；
- GitHub Release 中提供的 Windows 安装包；
- 可选的 DeepSeek、飞书或视觉服务账号。

第一次安装时，从以下文档开始：

1. [Windows 安装与数据库准备](docs/INSTALLATION.md)
2. [DeepSeek、飞书和视觉服务配置](docs/INTEGRATIONS.md)
3. 启动软件后进入左侧“设置 / 个性化”，决定是否启用专注窗口、评价、飞书卡片和健康参考。

外部服务全部是可选项。没有配置 AI 或飞书时，任务、排期、专注、复盘、成长和本地备忘录功能仍可独立使用。

## 开发者启动

### 环境要求

- Node.js 24 与 Corepack（仓库固定使用 pnpm 11.9.0）
- PostgreSQL 18.x
- Rust stable 和 Windows C++ Build Tools（仅桌面构建需要）

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
Copy-Item .env.example .env
corepack pnpm db:preflight
corepack pnpm db:migrate
corepack pnpm dev:local
```

Web 页面：`http://127.0.0.1:5173`

API 健康检查：`http://127.0.0.1:3000/health`

桌面开发：

```powershell
corepack pnpm dev:desktop
```

生成并校验 Windows 安装包：

```powershell
corepack pnpm build:desktop
```

## 仓库结构

- `apps/web`：React 用户界面
- `apps/api`：Fastify API、AI 编排和外部服务边界
- `apps/worker`：提醒、飞书投递和本地后台任务
- `apps/desktop`：Tauri Windows 桌面壳与独立专注窗口
- `packages/domain`：领域状态、输入校验和显式状态机
- `packages/db`：Drizzle 数据结构、迁移与数据库保护
- `docs`：产品规则、架构、安装、配置与发布文档

## 发布前验证

```powershell
corepack pnpm release:audit
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm build:desktop
```

Windows 安装包通过 GitHub Release 单独分发，不提交到 `main`。每个安装包必须同时提供 SHA-256 校验值。

## 当前限制

- 电脑关闭时，本地 Worker 和飞书提醒不会继续运行。
- 当前没有云端同步、多人协作或移动端客户端。
- 首个 Windows 版本可能尚未进行商业代码签名，Windows SmartScreen 可能显示信誉提醒。
- PostgreSQL 仍是外部本地依赖，尚未内置到安装包。
- 外部 AI 和飞书能力取决于用户自己的账号、额度、网络和服务可用性。

## 贡献、发布与许可证

- 贡献规则：[CONTRIBUTING.md](CONTRIBUTING.md)
- 架构说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- GitHub 发布计划：[docs/GITHUB_PUBLICATION_PLAN.md](docs/GITHUB_PUBLICATION_PLAN.md)
- 首次创建仓库与发布：[docs/GITHUB_FIRST_PUBLISH.md](docs/GITHUB_FIRST_PUBLISH.md)
- 开源许可证：[Apache License 2.0](LICENSE)

本项目采用 Apache License 2.0。允许使用、修改和再发布，并包含明确的专利授权；再发布时需要遵守许可证中的版权、许可证与变更说明要求。

---

**English summary:** A local-first, single-user Windows task and growth assistant covering scheduling, focus sessions, review, AI-assisted planning, health references and privacy-controlled external integrations. All plan changes remain subject to explicit user confirmation.
