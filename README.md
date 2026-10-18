# dsh-aoci-bind

DSH **Host 侧** AOCI 接入插件（v0.1.0）。

把「哪个工作区有 AOCI 索引、有没有对应的 MCP 服务器、绑到的是不是那个仓库」这件事，从手工维护
`cordis.patch.yml` 变成可发现、可诊断、可修复、可初始化的四条工具。

> 它不生成、不重写任何索引内容；只维护 **MCP 绑定行**。

## 解决什么

现在每接入一个工作区，都要手写一段：

```yaml
- insert:
    - id: aoci-gys
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: 'aoci-gys'
        transport: stdio
        command: 'C:/aoci/bin/aoci-rc19.exe'
        args: ['--repo', 'C:/Users/…/Gys', 'mcp']
```

手写会漏、会错、会重。真实缺口示例：`StoreProject` 有 `aoci.txt`，但没有任何 MCP 行——
会话里就是拿不到它的工具，而且**不会报错**。本插件把这类问题变成一条明确的状态与一条修复动作。

## 工具（4 个）

| 工具 | 作用 |
| --- | --- |
| `aoci_bind_status` | 逐工作区诊断：`bound` / `unbound`（有索引没绑定）/ `wrong_repo`（绑错仓库）/ `name_conflict`（serverName 冲突）/ `duplicate_binding`（重复行）/ `no_index`（还没初始化）。只读。 |
| `aoci_bind_repair` | 应用最小修复：补行、改 `--repo`、改 serverName、可选删除孤儿行。**幂等**；写前时间戳备份；非法 YAML 拒绝写入。 |
| `aoci_project_init` | 对没有索引的仓库跑 `aoci init` + `aoci scan`，注册绑定，并返回**bootstrap 提示词**（含 `mcp__<serverName>__` 前缀与 root 自检说明）。 |
| `aoci_doctor` | 环境体检：CLI 可达性与版本、补丁文件是否合法、serverName 唯一性、未绑定索引、孤儿行、workspace registry 是否可读。每项带 severity 与修复建议。 |

每个工具都返回**结构化 JSON + 可读摘要**（摘要由 `output.render` 渲染）。

## 安装

三种方式任选，推荐第一种（走 DSH 插件管理器，最稳）：

```powershell
# 1) 插件管理器（需要 DSH 的 plugin_manager 工具；装完需重启一次 DSH）
#    target 传本目录的绝对路径
plugin_manager { "action": "install_bundle", "target": "C:/…/default-workspace/dsh-aoci-bind" }

# 2) CLI
dsh plugin --profile desktop add file:C:/…/default-workspace/dsh-aoci-bind

# 3) 自带脚本（复制进 profile 并写挂载行；热加载，无需重启）
pwsh -NoProfile -File scripts/install.ps1
pwsh -NoProfile -File scripts/install.ps1 -Uninstall
```

安装脚本会：备份 profile 的 `cordis.patch.yml` → 在标记注释之间写入一行 `- insert:` 挂载条目 →
复制包到 `<profile>/node_modules/dsh-aoci-bind`。`-Uninstall` 完整回滚。

**Host 侧改动需要重启 DSH 才生效**（新增 MCP 行尤其如此）；插件本身不会重启 DSH。

## 配置

默认值即设计值；在 profile 的 `cordis.patch.yml` 里用同 `id` 覆盖：

```yaml
- id: aoci-bind
  config:
    enabled: true
    tools: true
    promptSection: false          # 注入一段「先确认 root 再使用 AOCI 工具」的系统提示词
    aociBinary: 'C:/aoci/bin/aoci-rc19.exe'
    home: 'C:/Users/me/.dsh-harness-next'   # 默认 $DSH_HOME
    profile: 'desktop'                       # 默认 $DSH_PROFILE
    legacyHome: 'auto'            # auto=旧 home 有文件才维护；on/off
    syncProfilePatch: true        # 同时维护 profiles/<profile>/cordis.patch.yml
    serverNamePrefix: 'aoci'
    scanRoots: []                 # 额外扫描目录；默认取已注册索引工作区的父目录
    backupDir: '<home>/aoci-bind/backups'
    initTimeoutMs: 180000
    probeTimeoutMs: 20000
```

## npm 发布：首版手动，之后 tag 自动

npm 的 Trusted Publisher（OIDC）只能给**已存在**的包配置。首版发布前包还不存在，因此：

1. **首版手动发**（维护者执行，需要交互式 2FA，或一个带 Bypass-2FA 的 granular token）：

   ```powershell
   npm publish --registry=https://registry.npmjs.org --access public
   ```

2. 首版发布后，到 `npmjs.com → dsh-aoci-bind → Settings → Trusted Publisher` 配置：

   | 字段 | 值 |
   | --- | --- |
   | Provider | **GitHub Actions** |
   | Organization or user | `donyue7` |
   | Repository | `dsh-aoci-bind` |
   | Workflow file | `publish.yml` |
   | Permissions | **Allow npm publish** |

3. 之后每次发版：

   ```powershell
   git tag v0.1.1 && git push --tags
   ```

   `.github/workflows/publish.yml` 会用 OIDC 自动 `npm publish --provenance`，**不需要任何长期 token**。
   配置了 stage-only 权限时，改为 `npm stage publish`，发布仍需维护者批准。

## 安全边界（为什么可以放心让它写配置）

- **只拼接、不重排**：编辑器是行模型，只替换/追加它自己拥有的 MCP 行，注释、空行、别人的行逐字节保留。
- **非法 YAML 一律拒绝**：写前写后都做结构校验（tab 缩进、引号未闭合、重复 id 都会拦下），拒绝时零写入。
- **每次写入先备份**：`<home>/aoci-bind/backups/<file>.<timestamp>.bak`。
- **原子写**：临时文件 + 替换，不会留下半个补丁文件。
- **幂等**：重复调用 repair 不产生第二行；第二次运行 `changes = []`。
- **删除是显式选项**：孤儿行只在 `prune_orphans: true` 时删除。

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/install.ps1` | 把插件装进 / 卸出一个 profile：写前备份、标记注释包裹的挂载行、复制包目录；`-Uninstall` 完整回滚 |
| `scripts/status.mjs` | **只读**演示：对真实 `$DSH_HOME` 跑 `aoci_bind_status` / `aoci_doctor` / `aoci_bind_repair --dry_run` |
| `scripts/apply.mjs` | 对真实 `$DSH_HOME` 执行 repair（带 `--dry-run` 只预览）；与 Host 工具走同一条代码路径 |

## 自测

```powershell
cd dsh-aoci-bind
node --test test/yamlpatch.test.mjs test/discovery.test.mjs test/binding.test.mjs test/tools.test.mjs test/plugin.test.mjs
```

37 个用例，覆盖：

| 验收点 | 用例 |
| --- | --- |
| 工作区发现（registry + 扫描根 + 去重 + 坏 registry） | `discovery.test.mjs` |
| 重复注册幂等（第二次 repair 零改动、文件逐字节不变） | `binding.test.mjs`、`tools.test.mjs` |
| serverName 防碰撞（同名目录 → `aoci-twin` / `aoci-twin-2`） | `binding.test.mjs` |
| **StoreProject 未绑定 → 修复 → 已绑定** | `binding.test.mjs`、`tools.test.mjs` |
| 损坏 YAML 拒绝（文件保持原样） | `binding.test.mjs`、`yamlpatch.test.mjs` |
| 旧 home `~/.dsh` 兼容（legacy-only 视为未绑定，repair 只写 active home） | `binding.test.mjs` |
| **与其它工具共存**：别的工具写入的行按 `--repo` 路径识别为已绑定，repair 不追加重复行；路径斜杠/大小写差异不影响识别 | `binding.test.mjs` |
| 非 AOCI 的 MCP 行（`zxy` / `omnisockit`）与本插件挂载行不被误判 | `binding.test.mjs` |
| 工具面（4 个工具、schema、渲染、错误路径） | `tools.test.mjs`、`plugin.test.mjs` |

测试全部在临时目录里构造 home / workspace / patch 文件，**不触碰真实 DSH 配置**。

## 0.1.0 的限制

- 只处理 **code 侧 MCP 行**，不管理 AOCI 索引内容、Baseline、scope。
- 绑定以「`--repo` 目录 = 已知工作区」为准；注册表里没有、也不在扫描根里的仓库需要显式加入 `scanRoots`。
- `aoci_project_init` 依赖本机 AOCI CLI；CLI 不可用时如实返回错误与步骤，不会假装成功。
- 新增 Host 行需要重启 DSH 后才会出现在会话工具表中。

## 许可

MIT
