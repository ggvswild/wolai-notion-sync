# 定时运行与安全迁移

## 每日任务

推荐每天运行一次新的扫描，而不是长期使用 `--resume`。先在终端通过 `check --remote` 和一次手工同步，再启用系统调度。

Linux/macOS cron 示例（所有路径都要替换为自己的实际路径；含空格路径需要加引号）：

```cron
30 3 * * * cd /path/to/wolai-notion-sync && /path/to/node --env-file=/secure/path/sync.env bin/cli.mjs sync --apply --data-dir /private/path/sync-data >> /private/path/sync.log 2>&1
```

任务使用机器本地时区。凭证放在仓库外的受保护文件或系统秘密存储，不直接写入 crontab。对于 systemd/macOS 定时服务，也使用同一 CLI，并明确工作目录、Node 路径、凭证环境和数据目录。

Windows 任务计划程序：创建一个每日任务，使用你的本地用户账户，程序填写 `node.exe` 的完整路径，参数填写：

```text
--env-file=C:\private\sync.env C:\projects\wolai-notion-sync\bin\cli.mjs sync --apply --data-dir C:\private\sync-data
```

存在空格时逐个路径加双引号。不要把 Token 放在任务名称、参数或公开导出的任务 XML 中。任务计划程序可能没有交互式终端的环境变量，优先使用明确的私人 env 文件。

示例 [sync.sh](../examples/sync.sh) 与 [sync.ps1](../examples/sync.ps1) 使用已配置的环境变量，不包含凭证。退出码 2 需要处理失败或冲突，3 需要继续下一批。不要把“进程启动成功”解释为整库完成。

## 首次大量回填

每批有操作额度，反复运行 `sync --apply --resume`，检查 `remaining` 和 `orderRemaining`。快照过期、来源在同步期间变化或遇到等待父页时，要重新扫描并处理父页原因。不要用删除状态/强行改成功版本消除队列。

## 换设备

1. 停止旧机器的定时任务，确认本地同步进程退出并释放锁。
2. 在新机器安装 Node、运行 `npm ci`，不要复制旧机器的 `node_modules` 或应用运行时目录。
3. 私下加密迁移整个运行数据目录（配置、状态、缓存、备份），但不复制 `.tree-sync.lock`。这是私人资料，不得发布到仓库或社区。
4. 在新机器单独提供自己的凭证，不需要迁移任何 Codex 配置或钥匙串。
5. 使用明确 `--data-dir` 运行 `check --remote`、无 `--apply` 的新扫描，并核对根绑定后再执行同步。
6. 只启用新机器的一个定时任务；旧机器继续保持停止。

只迁移本工具初始化的数据目录，不要直接导入其他同步工具的状态或手工补成功字段。首次使用建议在空目标根下试运行。

## 备份与冲突

备份运行数据时先停止同步，保证配置、状态及缓存一致。恢复只能使用同一来源范围与目标根的备份。目标手工正文、标题或父级发生冲突时先保留现场、检查差异；本工具不提供覆盖开关，不能忽略尾部空白块差异来“通过”验收。
