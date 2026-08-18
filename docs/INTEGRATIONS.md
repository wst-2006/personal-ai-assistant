# 外部服务配置

Personal AI Assistant 的外部服务全部通过本地 API/Worker 调用。密钥不会交给浏览器前端，也不能提交到 GitHub。

## 配置文件位置

桌面安装版：

```text
%APPDATA%\com.personalai.assistant\.env
```

源码开发版：仓库根目录下的 `.env`。

配置后需要完全退出桌面应用并重新启动，使本地 API 和 Worker 读取新值。

## DeepSeek

用途：自然语言任务候选、复盘回应、简报整理、长期计划任务树和健康参考候选。

在 DeepSeek 官方平台创建自己的 API Key，并根据官方文档确认当前可用模型：

- 平台：`https://platform.deepseek.com/`
- API 文档：`https://api-docs.deepseek.com/`

配置项：

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=请填写你的账号当前可用模型
```

模型名称和可用额度可能变化，以 DeepSeek 官方控制台和文档为准。不要把真实 Key 粘贴到 GitHub Issue、截图、浏览器控制台或公开聊天中。

## 飞书

用途：任务提醒、开始/另有安排/取消卡片，以及通过机器人发送文本来创建待确认的任务、想法或问题候选。

入口：

- 飞书开放平台：`https://open.feishu.cn/`
- 服务端文档：`https://open.feishu.cn/document/server-docs/getting-started/getting-started`

本地优先模式使用飞书官方长连接，不需要公网服务器或内网穿透。配置：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_TARGET_OPEN_ID=
FEISHU_CALLBACK_TRANSPORT=websocket
```

在飞书开放平台中需要：

1. 创建企业自建应用并启用机器人能力。
2. 从“凭证与基础信息”复制 App ID 和 App Secret。
3. 为机器人配置所需的消息与卡片权限。
4. 在事件订阅中使用长连接，并添加 `im.message.receive_v1`。
5. 发布应用版本，并确保目标用户能够使用该机器人。
6. 将允许操作卡片的用户 Open ID 写入 `FEISHU_TARGET_OPEN_ID`。

只有配置的目标用户可以通过飞书卡片或文本入口创建候选。飞书文本不会直接写入任务；仍需在候选卡片中确认。

如果改用 HTTP 回调，还需要：

```dotenv
FEISHU_CALLBACK_TRANSPORT=http
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
```

HTTP 回调属于高级部署方式，本地单机用户优先使用 `websocket`。

## 每日简报外部来源（当前关闭）

当前公开版本不启用以下能力：

- RSS/Atom 每日信息订阅；
- Tavily、Brave 或 GDELT 联网搜索；
- AI 侧边栏中的独立每日简报；
- Work Buddy 或飞书转发简报导入。

因此无需配置搜索 API Key、订阅地址或 Work Buddy 发送者 ID。`BRIEF_EXTERNAL_SOURCES_ENABLED=false` 用于明确保持这条外部链路关闭。飞书机器人接收任务、想法、问题和健康补充的功能不受影响。

复盘页原有的本地收卷/日记数据链路继续保留，只使用用户自己的复盘与任务材料，不向新闻订阅或搜索服务发起请求。

## 视觉模型

用途：可选的睡眠截图分析。它与 DeepSeek 文本模型分开配置。

默认示例使用阿里云百炼 / Model Studio 的 OpenAI 兼容接口：

```dotenv
VISION_API_KEY=
VISION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=请填写支持图片输入的模型
```

官方文档：`https://help.aliyun.com/zh/model-studio/`

必须选择明确支持图片输入的模型。没有配置或模型不支持图片时，睡眠截图分析会显示不可用，不会伪造结果。

## 配置安全检查

- `.env` 只能保存在本机用户目录或源码根目录，不要改成 `.env.example`。
- 不要把真实密钥写入 `apps/web`、公开静态文件或前端构建变量。
- 不要提交数据库 URL、飞书事件样例、日志、备份或包含个人任务的截图。
- 一旦密钥进入 Git 历史，应立即在服务商控制台撤销或轮换；只删除最新文件是不够的。
- 发布前运行 `corepack pnpm release:audit`。
