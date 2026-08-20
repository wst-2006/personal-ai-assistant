# 第一次发布到 GitHub

本文把“项目准备”和“账号操作”分开。项目维护者可以协助整理本地代码，但不需要、也不应该获得仓库所有者的 GitHub 密码、验证码或 API Key。

## 不要提供账号密码

GitHub 的 Git 操作不使用账号密码验证。第一次发布推荐二选一：

1. **GitHub Desktop**：适合第一次使用 GitHub 的用户，通过浏览器登录授权。
2. **GitHub CLI**：运行 `gh auth login`，选择 GitHub.com、HTTPS 和浏览器登录。

只有在明确需要自动化时才创建最小权限的 Personal Access Token；不要把 Token 发给协作者或写进仓库。

## 推荐仓库策略

- 仓库名：`personal-ai-assistant`
- 产品名继续使用：`Personal AI Assistant`
- 默认分支：`main`
- 第一步先建立 **Private** 仓库作为 staging。
- 私有仓库检查通过后再改为 Public。
- 安装包只放 GitHub Release，不提交到 `main`。
- 关闭不需要的 Wiki；Issues 可以开启，用于错误反馈。
- 公开后启用 Security Advisories、secret scanning 和 push protection（账号套餐支持范围以 GitHub 页面为准）。

## 仓库所有者需要亲自完成的第一步

1. 登录 GitHub。
2. 点击右上角 `+` → `New repository`。
3. Repository name 填 `personal-ai-assistant`。
4. Visibility 先选 `Private`。
5. **不要勾选**自动添加 README、`.gitignore` 或 License；本地项目已经包含这些文件，避免第一次同步出现冲突。
6. 点击 `Create repository`。
7. 复制仓库的 HTTPS 地址。

完成后，只需要把 HTTPS 仓库地址提供给项目维护者，或者自己按照 GitHub 页面给出的命令添加远程地址。不要提供密码、Token 或验证码。

## 公开前已确认与仍需完成的事项

### 1. 许可证

已确定采用 [Apache License 2.0](../LICENSE)。该许可证允许商业和非商业使用、修改及再发布，同时提供明确的专利授权和专利终止条款。再发布者仍需保留许可证、相关版权与 NOTICE 信息，并说明对原文件所做的重大修改。

### 2. 公开署名

Git 提交会公开作者名称和邮箱。发布前由仓库所有者自行选择非个人化的提交署名，并确认不会暴露个人邮箱、设备路径或其他账号信息。

### 3. 宣传截图

只能使用演示数据：虚构任务、模糊地点、空白 API 配置和无个人健康信息。推荐素材清单见 [media/README.md](media/README.md)。

## 发布前检查顺序

1. 在本地运行公开边界审计。
2. 确认 `.env`、数据库、日志、备份、测试报告和安装包不在 Git 跟踪列表中。
3. 从干净克隆只使用 `.env.example` 完成安装依赖、类型检查、测试和构建。
4. 将整理后的提交推到 Private staging 仓库。
5. 在 GitHub 页面再次检查文件、提交作者和 Actions 结果。
6. 使用虚构演示数据安装并验收 Release 安装包。
7. 确认仓库中的 Apache-2.0 许可证和提交署名不包含个人信息。
8. 最后才把仓库改为 Public。

## 创建首个 Release

建议使用与应用版本一致的标签，例如 `v0.1.20`。

Release 附件只包含：

- `Personal AI Assistant_0.1.20_x64-setup.exe`
- `SHA256SUMS.txt`

首个未签名版本建议勾选 **Set as a pre-release**，并在说明中明确 Windows SmartScreen 可能显示提醒。不要把 `.env`、数据库、日志、源码工作目录压缩包或个人截图作为附件。

## 用户最终需要操作什么

项目准备完成后，仓库所有者只需要亲自处理：

1. 创建 Private 空仓库并提供 HTTPS 地址；
2. 在 GitHub 登录授权或 GitHub Desktop 中点击推送；
3. 检查提交署名、文件列表和历史中没有个人信息；
4. 检查无误后再决定仓库可见性；
5. 在 Release 页面上传安装包和校验文件。

其他本地整理、脱敏检查、README、配置文档、提交清单和构建验证都可以在不接触账号密码的情况下完成。
