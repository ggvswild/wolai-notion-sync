# Wolai → Notion 操作演示

[在线播放 / 下载中文视频（约 3 分 41 秒）](https://d1.music.126.net/dmusic/35bf/351c/7ed5/ccb22e35a81a28a49529bf5f67aeacbd.mp4?infoId=4482506) · [仓库内视频](media/wolai-notion-setup.zh-CN.mp4) · [字幕](media/wolai-notion-setup.zh-CN.srt) · [文字讲解](media/narration.txt)

![视频封面](media/scene-01.jpg)

内容覆盖 Wolai MCP Token 的入口、Notion PAT 与内部连接、目标页面访问、两个根页面 ID、本地 `.env`、初始化、只读预览、分批同步、验收和交给 AI agent 的提示词。

视频中的 Notion 表单、凭证录入和终端命令为操作示意。请使用自己的账号和页面 ID，并以 README 中的完整命令为准。

## 章节

| 时间 | 内容 |
| --- | --- |
| 00:00 | 准备两项凭证和两个页面 ID |
| 00:17 | Wolai 个人设置入口 |
| 00:33 | Wolai MCP 接入与创建 Token |
| 00:51 | Notion 个人访问令牌 PAT |
| 01:09 | 内部连接及目标页面授权 |
| 01:28 | 选择来源根和目标根 |
| 01:47 | 本地 `.env` |
| 02:03 | 安装依赖、初始化 |
| 02:21 | 连接检查与只读计划 |
| 02:43 | 分批同步与验收 |
| 03:02 | 交给 AI agent |
| 03:22 | 正确理解媒体和数据库例外 |

时间点取近似秒值；精确时间见 [chapters.json](media/chapters.json)。完整可复制命令仍以 [README](../README.md) 和 [AI 快速指南](../docs/ai-quickstart.md) 为准。

## 操作参考

- [Notion 开发者入口](https://www.notion.so/profile/integrations)：登录自己的账号后操作。
- [Notion 官方 PAT 指南](https://developers.notion.com/guides/get-started/personal-access-tokens)：PAT 使用创建者的页面权限。
- [Notion 官方内部连接指南](https://developers.notion.com/guides/get-started/internal-connections)：内部连接需要授权访问目标页面。
- Wolai 入口：更多操作 → 个人设置 → MCP 接入。
