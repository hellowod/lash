# lash

`lash` 是一个极简的智能体启动器：用同一条命令把任务交给 Codex、Claude Code、Pi 或任何你自己配置的 CLI 智能体。

```bash
lash run codex "重构这个函数"
lash chat codex
lash run my-agent -- --verbose "分析当前项目"
```

npm 包名是 `lashhub`，安装后提供的命令仍然是 `lash`。

## 安装

### 从 npm 安装

```bash
npm install --global lashhub
lash --version
```

### 从源码安装为全局命令

```bash
npm run install:global
```

`install:global` 会安装依赖并执行 `npm link`，适合本地开发调试。

需要 Node.js 20 或更新版本。

`lash` 只负责启动和恢复智能体，不负责安装智能体本体。Pi 需要单独安装：

```bash
npm install --global @earendil-works/pi-coding-agent
```

## 内置智能体

| 名称 | 带任务参数时 | 不带参数时 |
| --- | --- | --- |
| `codex` | `codex exec --skip-git-repo-check --color never <args...>` | `codex` |
| `claude` | `claude <args...>` | `claude` |
| `pi` | `pi --print <args...>` | `pi` |

因此下面这些命令都直接可用：

```bash
lash run codex "重构这个函数"
lash run claude "帮我排查测试失败"
lash run pi "解释这个仓库的架构"
lash chat codex "从这个任务开始，进入持续对话"
```

## 一次性任务与持续对话

`run` 适合明确的一次性任务：带任务参数时会使用智能体的 `args`，例如 Codex 会走 `codex exec`：

```bash
lash run codex "重构这个函数"
lash run claude "帮我排查测试失败"
lash run pi "解释这个仓库的架构"
```

`chat` 会强制进入持续交互对话，并始终使用智能体的 `interactiveArgs`。即使提供初始提示词，也不会切换到一次性任务模式：

```bash
lash chat codex
lash chat codex "hello"
lash chat claude
lash chat pi "先分析这个项目"
```

继续旧会话请使用 `resume`，不要把 `chat` 和会话恢复混在一起：

```bash
lash resume codex --last
lash resume codex --last "继续刚才的任务"
```

## 添加任意智能体

最快的方式：

```bash
lash add qwen -- qwen
lash run qwen "解释这个仓库的架构"
```

默认写入项目配置 `.lash/agents.json`。加 `--user` 会写入用户级配置 `~/.lash/agents.json`：

```bash
lash add qwen --user -- qwen --profile coding
```

等价的 JSON 配置：

```json
{
  "agents": {
    "qwen": {
      "command": "qwen",
      "args": ["--profile", "coding"]
    }
  }
}
```

`args` 会出现在 lash 收到的任务参数之前；`interactiveArgs` 用于 `lash run qwen` 不带任务参数的场景，以及所有 `lash chat qwen` 调用。

## 继承和覆盖已有智能体

自定义智能体可以用 `extends` 继承任何已有智能体，并追加参数、环境变量或修改工作目录：

```json
{
  "agents": {
    "codex-safe": {
      "extends": "codex",
      "appendArgs": ["--sandbox", "workspace-write"],
      "description": "Codex with workspace-write sandbox"
    },
    "pi-coding": {
      "extends": "pi"
    },
    "claude-code": {
      "extends": "claude"
    },
    "claude-verbose": {
      "extends": "claude",
      "appendArgs": ["--verbose"],
      "env": { "ANTHROPIC_LOG": "debug" },
      "cwd": "./"
    }
  }
}
```

解析规则：

- `command`：未设置时继承父智能体。
- `args` / `interactiveArgs`：设置后完整替换父配置。
- `appendArgs` / `appendInteractiveArgs`：追加到继承到的参数后面。
- `env`：与父配置合并，子配置优先。
- `cwd`：可选，默认使用当前运行 `lash` 的目录。

配置优先级为：

```text
内置配置 < ~/.lash/agents.json < ./.lash/agents.json
```

## 会话管理

`lash` 内置了 Codex、Claude Code 和 Pi 的原生会话读取与恢复能力。默认只显示当前目录的会话，避免不同项目之间的历史互相干扰。

### 查看当前目录会话

```bash
lash sessions
lash sessions codex
lash sessions claude
lash sessions pi
```

输出示例：

```text
#   AGENT    UPDATED               ID                                   TITLE / CWD
 1  codex    2026/9/21 16:05:30   01a0c2fc-094c-71a2-861b-06739b5f2b61 实现 lash 智能体 CLI
```

### 查看全部目录、归档会话或限制数量

```bash
lash sessions --all
lash sessions codex --archived
lash sessions codex --limit 20
lash sessions --json
```

### 查看最近一次会话

```bash
lash last
lash last codex
lash last codex --json
lash last codex --all
lash last pi
```

### 恢复会话

打开当前智能体自己的会话选择器：

```bash
lash resume codex
lash resume claude
lash resume pi
```

恢复当前目录最近一次会话：

```bash
lash resume codex --last
lash resume claude --last
lash resume pi --last
lash resume codex --last "继续刚才的任务"
lash resume claude --last "继续刚才的任务"
lash resume pi --last "继续刚才的任务"
```

按 `lash sessions` 输出的序号恢复：

```bash
lash resume codex 1
lash resume claude 2 "继续刚才的任务"
lash resume pi 3 "继续刚才的任务"
```

也可以使用完整 ID、ID 前缀或标题：

```bash
lash resume codex 01a0c2fc-094c-71a2-861b-06739b5f2b61
lash resume codex 01a0c2fc "继续刚才的任务"
lash resume codex "实现 lash 智能体 CLI"
```

如果目标会话在其他目录，先加 `--all`：

```bash
lash resume codex --all 01a0c31c-f941-7f30-8204-5d44d73c3d4c
```

Codex 的交互式会话会使用 `codex resume <id>` 恢复；`codex exec` 产生的一次性任务会自动改用 `codex exec ... resume <id>` 恢复。Claude Code 会使用 `claude --resume <id>` 恢复；Pi 会使用 `pi --session <id>` 恢复。

### 自定义智能体的会话恢复

自定义智能体可以配置 `session.provider` 和 resume 参数模板：

```json
{
  "agents": {
    "qwen": {
      "command": "qwen",
      "args": [],
      "session": {
        "provider": "manual",
        "pickerArgs": ["--resume"],
        "resumeArgs": ["--resume", "{sessionId}"]
      }
    }
  }
}
```

然后可以执行：

```bash
lash resume qwen
lash resume qwen 11111111-1111-4111-8111-111111111111
```

`manual` 表示 `lash` 不负责枚举该智能体的历史文件，但可以把已知 UUID 传给它的 resume 参数。继承 `codex`、`claude` 或 `pi` 的自定义智能体会同时继承它们的会话配置。

## 常用命令

```bash
lash chat codex        # 开启持续交互对话
lash list              # 查看所有智能体
lash show codex-safe   # 查看解析后的完整定义
lash path              # 项目配置路径
lash path --user       # 用户配置路径
lash init              # 创建空项目配置
lash remove qwen       # 删除项目里的 qwen
lash --help
```

## 作为 Node.js 库使用

```js
import { AgentRegistry, runCli } from 'lashhub';

const registry = new AgentRegistry();
console.log(registry.names());
console.log(registry.resolve('codex'));
```

公开 API 位于 `src/index.js`。

## 设计边界

`lash` 不包裹、不截获、不改写智能体输出。任务参数会原样追加到目标命令后面，进程直接继承当前终端，所以交互模式、颜色、进度和退出码都能正常工作。Windows 上的 `.cmd` / `.bat` 启动由 `cross-spawn` 处理。

## 项目结构

```text
src/        核心源码、CLI 可执行入口和公开 API
test/       Node.js 内置测试
scripts/    开发辅助脚本
```

## 开发与发布

```bash
npm test             # 运行测试
npm run check        # 测试并检查 npm 包内容
npm publish          # 发布；发布前会自动执行 npm run check
```

如果你的 npm 默认 registry 是镜像源，发布到 npm 官方源时需要显式指定：

```bash
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org
```

MIT License.
