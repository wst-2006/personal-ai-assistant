# Windows 安装与首次启动

本文面向第一次使用 Personal AI Assistant 的普通用户。安装过程不需要 GitHub 开发经验，但当前版本需要在本机安装 PostgreSQL 18.x。

## 1. 准备 PostgreSQL

从 PostgreSQL 官方 Windows 下载页面安装 PostgreSQL 18.x：

`https://www.postgresql.org/download/windows/`

安装时保存好你为 PostgreSQL 管理员设置的密码。应用不会读取或上传这个管理员密码。

打开 pgAdmin 的 Query Tool，使用管理员账号执行：

```sql
CREATE ROLE personal_ai_app WITH LOGIN PASSWORD '请替换为你自己的强密码';
CREATE DATABASE personal_ai_assistant OWNER personal_ai_app;
```

应用只允许迁移以下目标：

- 主机：`127.0.0.1`
- 端口：`5432`
- 数据库：`personal_ai_assistant`
- 用户：`personal_ai_app`
- PostgreSQL 主版本：`18`

数据库保护检查不通过时，应用会拒绝迁移，避免误操作其他项目的数据库。

## 2. 安装桌面程序

1. 打开项目 GitHub 页面的 **Releases**。
2. 下载 `Personal AI Assistant_<版本>_x64-setup.exe`。
3. 同时下载或复制 Release 中公布的 SHA-256。
4. 安装后启动一次应用。

首次启动不会包含作者的配置。应用只会在下列位置创建一份属于当前 Windows 用户的配置文件，然后要求你填写数据库信息：

```text
%APPDATA%\com.personalai.assistant\.env
```

可在 PowerShell 中运行下面这条命令打开它：

```powershell
notepad "$env:APPDATA\com.personalai.assistant\.env"
```

## 3. 填写数据库连接

找到：

```dotenv
DATABASE_URL=postgresql://personal_ai_app:replace-with-url-encoded-password@127.0.0.1:5432/personal_ai_assistant
```

将 `replace-with-url-encoded-password` 替换成你刚才为 `personal_ai_app` 设置的密码。

如果密码中包含 `@`、`:`、`/`、`#`、`?`、`%` 等 URL 保留字符，需要先进行 URL 编码。第一次配置时也可以使用由大小写字母和数字组成的高强度随机密码，减少手动编码错误。

其余数据库保护项保持：

```dotenv
EXPECTED_DB_HOST=127.0.0.1
EXPECTED_DB_PORT=5432
EXPECTED_DB_NAME=personal_ai_assistant
EXPECTED_DB_USER=personal_ai_app
EXPECTED_PG_MAJOR=18
```

保存文件并重新启动应用。应用会先执行数据库保护检查，再自动应用随版本提供的迁移。

## 4. 选择是否配置外部服务

DeepSeek、飞书和视觉模型全部是可选项。需要时继续阅读 [INTEGRATIONS.md](INTEGRATIONS.md)。不配置这些服务也可以使用本地任务、排期、专注、复盘、成长和备忘录功能。当前公开版本不启用 Agent 联网搜索、独立每日简报或 Work Buddy 简报导入。

## 5. 第一次进入软件

建议依次完成：

1. 打开左侧“设置 / 个性化”，保存个人信息和交互偏好。
2. 决定是否开启桌面专注窗口、准备倒计时和任务评价。
3. 决定是否开启飞书任务卡片与健康参考页。
4. 在“今天”创建一个无敏感内容的测试任务，完成一次排期与专注流程。
5. 在“复盘”和“成长”检查记录是否正确保存。

## 常见问题

### 提示配置文件仍有占位符

打开 `%APPDATA%\com.personalai.assistant\.env`，确认 `DATABASE_URL` 中已经没有 `replace-with-url-encoded-password`。

### 无法连接 PostgreSQL

确认 PostgreSQL 服务正在运行，端口为 `5432`，数据库和角色名称与本文完全一致。

### 端口 3000 已占用

关闭正在运行的源码 API、旧版桌面程序或其他占用 `127.0.0.1:3000` 的程序，再重新启动。

### Windows 显示 SmartScreen 提醒

首个公开版本可能没有商业代码签名。请只从项目官方 GitHub Release 下载，并核对 SHA-256；不要使用第三方重新打包版本。

### 安装或升级会不会上传数据

不会。配置、数据库、任务和健康内容保持在本机。安装包不包含作者的 `.env`、API Key、数据库或个人数据。
