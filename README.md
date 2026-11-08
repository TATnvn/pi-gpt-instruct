**简体中文** | [English](README.en.md)

![pi-gpt-instruct](assets/hero.webp)

# pi-gpt-instruct

适用于 PI Coding 的 GPT 系列模型破甲插件。

## 安装与快速上手

**环境要求**：Pi Coding Agent、`git`、`python3`（适用于 Linux 与 macOS；Windows 用户建议在 WSL 环境下运行）。

```bash
pi install git:github.com/TATnvn/pi-gpt-instruct
```

在已有 Pi 会话中运行 `/reload` 加载扩展。加载后即可在当前会话中启用并查看生效状态：

```text
/gpt-instruct on
/gpt-instruct status
```

若希望所有未手动设置过的会话均默认开启，可执行全局默认配置：

```text
/gpt-instruct default on
```

## 命令与开关规则

扩展安装后全局默认处于关闭（`off`）状态。所有开关变更均在**下一轮对话开始时**生效。

| 命令 | 适用范围 | 说明 |
|---|---|---|
| `/gpt-instruct on` | 当前会话 | 在当前会话开启提示词替换（优先级高于全局默认） |
| `/gpt-instruct off` | 当前会话 | 在当前会话关闭提示词替换（优先级高于全局默认） |
| `/gpt-instruct reset` | 当前会话 | 清除当前会话的独立设置，恢复跟随全局默认 |
| `/gpt-instruct default on` | 全局 | 设置全局默认开启，未单独设置的会话从下一轮起生效 |
| `/gpt-instruct default off` | 全局 | 设置全局默认关闭 |
| `/gpt-instruct status` | - | 查看全局状态、当前会话设置与当前匹配文件（直接运行 `/gpt-instruct` 效果相同） |
| `/gpt-instruct update` | - | 忽略检查周期，立即从上游强制同步最新提示词 |

## 提示词匹配与更新

### 模型匹配机制

扩展开启且本地存在对应提示词文件时，文件内容会替换该轮的 system prompt。匹配按当前模型 ID 前缀进行，忽略大小写，优先选用最长匹配项：

| 模型 ID 示例 | 匹配提示词文件 | 说明 |
|---|---|---|
| `gpt-5.6-sol` | `gpt-5.6-sol.md` | 支持带日期后缀的模型（如 `gpt-5.6-sol-20261101`）；同步时生成 `gpt-5.6.md` 广义别名 |
| `gpt-6-astra` | `gpt-6-astra.md` | 支持带后缀的模型前缀匹配 |
| `gpt-6.1-sol` | `gpt-6.1-sol.md` | 支持带后缀的模型前缀匹配 |

本地提示词存放在 `~/.pi/agent/prompt-files/`，用户亦可在此添加自定义 Markdown 提示词。若上游后续发布同名文件，自动同步会覆盖本地同名文件。

### 同步与备份

扩展在 Pi 启动及每轮对话开始时按需检查上游版本，检查成功后的默认间隔为 6 小时；网络不可用时继续使用本地现有文件。各模型线自动同步最高发布版本（包含 RC 预发布版）。提示词更新前，原有文件会自动备份至 `~/.pi/agent/gpt-instruct-backups/`。

## 致谢与许可证

- 本项目采用 MIT 许可证。
- 提示词设计来自开源项目 [MDX-Tom/gpt-instruct](https://github.com/MDX-Tom/gpt-instruct)（原作者：li lingbo、yynxxxxx 及社区贡献者）。
