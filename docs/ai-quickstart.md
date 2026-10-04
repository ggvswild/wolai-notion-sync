# 给 AI Agent 的快速使用指南

把下面的提示词复制给能操作本地终端的 AI agent，替换 **项目路径、Wolai 根 ID、Notion 目标根 ID** 三项即可。凭证须先在本机 `.env` 或系统环境中安全配置；不需要发给 AI，也不需要把私人笔记放进项目。

不熟悉 Token 和页面授权操作时，先看 [约 4 分钟的视频演示](../tutorial/README.md)。

## 首次 / 恢复同步：直接复制

```text
请使用 wolai-notion-sync 完成一次安全的单向同步。

项目路径：<PROJECT_DIR>
Wolai 来源根页面 ID：<WOLAI_ROOT_PAGE_ID>
Notion 目标导出根页面 ID：<NOTION_ROOT_PAGE_ID>
私人数据目录：项目下的 .wolai-notion-sync

我授权将上述 Wolai 根及所有层级后代、可处理的图片附件同步到指定 Notion 根下；预览后可直接执行写入。不授权回写 Wolai、删除页面、覆盖手工内容、公开数据、改权限/凭证或创建定时任务。

先阅读 docs/ai-quickstart.md、README.md 和 SECURITY.md，然后按以下流程执行：

1. 在项目目录确认 Node.js >=22.19，运行 npm ci。使用项目现有 CLI，不修改源码或安全规则来强行完成。
2. 凭证已在本机 .env 或系统环境中配置。不要显示 .env、输出 Token、向聊天索要 Token，或从其他应用复制凭证。若缺少凭证/授权，停止并说明本地配置方法；若参数仍是占位符，只询问页面 ID，不猜测其他目录。
3. 如 .wolai-notion-sync 已有配置或状态，只读取配置中的来源/目标并核对与上述参数一致；不一致或状态不完整就停止，不能重初始化覆盖。若两者均不存在，运行：
   node bin/cli.mjs init --source-root <WOLAI_ROOT_PAGE_ID> --notion-root <NOTION_ROOT_PAGE_ID>
4. 以下命令以 .env 存在为例；如果使用系统环境变量，去掉 --env-file=.env，其他参数不变：
   node --env-file=.env bin/cli.mjs check --remote
   node --env-file=.env bin/cli.mjs sync
   检查本次只读计划的范围与扫描结果。预检或扫描失败时不要执行写入。
5. 范围正确后运行：
   node --env-file=.env bin/cli.mjs sync --apply
   退出码 3 表示正常分批未结束，继续：
   node --env-file=.env bin/cli.mjs sync --apply --resume
   快照过期或来源读取期间变化时，去掉 --resume 重新扫描。退出码 2、手工冲突、连续两批完全没有实际同步/排序进展时停止并报告；不清除锁或恢复日志、不修改成功版本/正文基线，不把旧报告当作本次结果。不要并行启动写入进程或让另一台机器同时写同一目标。
6. 只有本次 remaining=0、orderRemaining=0、navigationComplete=true，才运行：
   node --env-file=.env bin/cli.mjs verify
   验收报告 accepted=true 后才能报告本次验收通过；失败就保留现场。
7. 最后仅简报扫描、创建、更新、移动、排序、冲突、失败、正文/目录剩余及报告路径。分别说明超限来源链接、ZIP 原件、整页 ZIP、数据库容器/未复制记录和格式例外；不要称作所有内容均内联成功，也不要把媒体抽样说成全部媒体字节验收。不要展示笔记正文、凭证或完整状态/缓存。
```

## 已初始化工作区：下次只需一句话

```text
在 <PROJECT_DIR> 复用现有 .wolai-notion-sync 配置，按 docs/ai-quickstart.md 的安全规则执行一次新的 Wolai→Notion 增量同步：先 check --remote 和只读计划，再 sync --apply；正常未结束则分批续传，冲突/失败停止。不要默认使用旧快照，不创建定时任务，完成后只报告数量、例外和验收结果，不回显凭证或笔记。
```

运行这些提示词是 **一次同步**，不会自动安装每日任务。需要定时运行时另行授权，并参考 [运行手册](operations.md)。命令和提示词已按当前 CLI 校对；真实账号的连接权限仍须使用者自行准备。
