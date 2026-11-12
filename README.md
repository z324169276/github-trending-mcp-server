# github-trending-mcp-server

GitHub 趋势榜 MCP Server。让 Claude Code、Trae、Cursor、Claude Desktop 等支持 MCP 的客户端直接查询 GitHub 热门仓库、搜索项目、读取仓库详情、横向对比技术选型。

零依赖，只用 Node.js 内置模块，不需要装任何 npm 包。

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `trending_repos` | 查询近期热门仓库。`mode=new` 找最近新建且涨星快的项目，`mode=active` 找近期仍在更新、Star 较高的成熟项目 |
| `search_repos` | 按关键词搜索仓库，支持语言、最低 Star、排序方式过滤 |
| `repo_detail` | 单个仓库详情：Star / Fork / Issue、语言、许可证、最近推送，以及 README 摘录 |
| `compare_repos` | 2–8 个仓库横向对比，用于技术选型 |

## 安装

需要 Node.js 18 或更高版本。

### 一行命令（npx）

```bash
claude mcp add github-trending -- npx -y github-trending-mcp-server
```

### 手动配置

Claude Desktop / Cursor / Trae 等客户端的 MCP 配置文件中加入：

```json
{
  "mcpServers": {
    "github-trending": {
      "command": "npx",
      "args": ["-y", "github-trending-mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_你的token"
      }
    }
  }
}
```

### 本地源码运行

clone 后直接指向入口文件，适合改代码时调试：

```json
{
  "mcpServers": {
    "github-trending": {
      "command": "node",
      "args": ["/绝对路径/github-trending-mcp-server/src/server.js"]
    }
  }
}
```

Windows 路径要写成双反斜杠，例如 `E:\\path\\to\\github-trending-mcp-server\\src\\server.js`。

## 关于 GitHub Token

不配置也能用，但额度很低：

| 状态 | Search API | 核心 API |
| --- | --- | --- |
| 未配置 Token | 10 次/分钟 | 60 次/小时 |
| 配置 Token | 30 次/分钟 | 5000 次/小时 |

Token 读取顺序：`GITHUB_TOKEN` 环境变量 → `GH_TOKEN` 环境变量 → `gh auth token`（本机已登录 GitHub CLI 时自动复用）。

创建一个只读的 Personal Access Token 即可，不需要任何 scope，地址：<https://github.com/settings/tokens>

## 使用示例

在支持 MCP 的客户端里直接说：

- 「看看最近一周 GitHub 上有什么新的 Python 项目火起来了」
- 「搜一下和 MCP 相关的开源项目，Star 超过 1000 的」
- 「react 和 vue 这两个仓库现在各自什么情况，帮我对比一下」
- 「读一下 deepseek-ai/DeepSeek-V3 的 README，讲讲它是怎么训练推理的」

## 设计说明

GitHub 官方没有公开 trending 接口，本项目的热门榜走 GitHub Search API 构造：

- **新星（`mode=new`）** — `created:>起始日期 stars:>阈值`，按 Star 排序。观察窗口分别是近 7 / 30 / 90 天（对应 `period` 的 day / week / month），因为刚创建的项目需要更长窗口才看得出趋势。
- **活跃（`mode=active`）** — `pushed:>起始日期 stars:>阈值`，按 Star 排序。窗口是近 1 / 7 / 30 天，用于筛选仍在维护的高星项目。

它衡量的是「累计 Star 高且近期有动静」，不是「这周涨了多少星」——后者需要持续采集历史快照才能计算，超出单个 MCP Server 的能力范围。

请求做了串行节流与自动重试，触发限流时按 `x-ratelimit-reset` 等待重置，不会直接报错给模型。

## 目录结构

```
github-trending-mcp-server/
├─ package.json
└─ src/
   ├─ server.js     # MCP stdio 协议实现（JSON-RPC 2.0）
   ├─ tools.js      # 四个工具的定义与实现
   └─ github.js     # GitHub REST 客户端（节流、重试、限流等待）
```

## License

[MIT](./LICENSE)
