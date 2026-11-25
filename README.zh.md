# dsh-guard

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的**沙箱之前的语义闸门**。

它在每个 `pwsh` / `write` 工具调用**执行之前**做判定与分类，只把真正值得人看一眼的操作升级为审批：批量删除、递归遍历、批量改写，以及任何指向"本会话工作区之外"的动作。**读操作一律不问**；工作区内的**具名单文件**也不问。每次判定都落进追加式台账，弹窗首行是一句分类结论，而不是一串规则名。

```
dsh-guard ASK [ps-recursive-delete, external-path-target]: BULK DELETES paths OUTSIDE this project workspace
  - 摘要: 批量删除（本工作区外）
  - decision: the call has NOT run; approve only if you intend exactly this scope.
  - workspace: F:\work\my-project (this session's own workspace root)
  - rule: ps-recursive-delete -- PowerShell recursive delete (-Recurse / -r)
  - rule: external-path-target -- a destructive verb aimed at a path outside every trusted root of this session
  - target: Remove-Item -Recurse -Force C:\Users\me\Desktop
```

> 完整参考（英文，含全部字段与自测细节）：[README.md](README.md)。本文件给中文使用者一份可直接照做的说明。

- [它做什么](#它做什么)
- [环境要求](#环境要求)
- [安装](#安装)
- [验证安装](#验证安装)
- [配置](#配置)
- [怎么用](#怎么用)
- [能观察到什么](#能观察到什么)
- [三个紧急开关](#三个紧急开关)
- [判定分层](#判定分层)
- [更新与卸载](#更新与卸载)
- [故障排查](#故障排查)
- [如实说明的限制](#如实说明的限制)
- [开发](#开发)

---

## 它做什么

| 行为 | 说明 |
|---|---|
| **读操作永不升级** | 命令里没有修改性动词就放行，带通配符也一样：`Get-Item a, b`、`Get-ChildItem -Recurse -Filter *.json \| Select-Object -First 3`、`git status`、`rg`。 |
| **工作区内具名单文件放行** | `Remove-Item .\out\old.js`、`write` 写入本会话工作区内的文件。 |
| **批量 / 遍历 / 大范围询问** | 递归删除、通配目标、管道喂给修改性 cmdlet、递归拷贝、解包、整树 git 回退、间接执行（`cmd /c`、`Invoke-Expression`、`wsl`）、多个真实目标。 |
| **工作区外询问** | 任何破坏性动词指向本会话工作区之外（也不在 dsh home / 状态目录内）的目标。 |
| **无界目标硬拦** | 删除盘根、`rm -rf /`、`Format-Volume` / `Clear-Disk`。 |
| **沙箱升权地板** | 带 `sandbox_permissions`（平台那条"这一次调用让沙箱让开"的升权）的调用，只在**越界**时升级：删除，或大批量改写。工作区内的单文件写入、只读命令即使带该字段仍放行。 |
| **每次判定都有记录** | 每次调用追加一行 JSONL：决定、命中规则、动作类别、是否批量、范围内外、判定用的工作区根、区外目标、请求的升权模式、模型自己写的理由。 |

闸门挂在 `tools/pre-execute`，而 `dsh-tools` 的流水线是：`tools/pre-execute` → 单调 guard → `tools/execute` → `tools/post-execute`。**沙箱模式与审批策略都在它之后才被解析**，插件也从不读模式——所以在 Permissions 里选 `read-only` / `workspace-write` / `danger-full-access`，对判定**不可见**。能改变它行为的只有插件自己的配置和下面三个紧急开关。

## 环境要求

| | |
|---|---|
| dsh | profile 需要组合 `@deepseek-ai/dsh-tools` 与 Windows 的 `pwsh` 执行器（`@deepseek-ai/dsh-pwsh-sandbox`）。随包发布的 `desktop` profile 已满足。 |
| 系统 | Windows（规则覆盖 PowerShell 与 cmd 语法；安装器是 PowerShell）。 |
| Node | 仅离线自测与 `scripts/sync-source.mjs` 需要。**插件本体只 import Node 标准库，无任何第三方依赖。** |
| 权限 | 对 `%USERPROFILE%\.dsh\profiles\<profile>\` 的写权限，别无其他。 |

> **为什么下面的脚本安装必须由普通终端做、而不是让 dsh 里的 agent 做**：profile 目录在 dsh 会话的文件沙箱之外，dsh 会话根本写不进去（沙箱比守卫更早拒绝）。**从 npm 安装**走 DSH 自己的插件管理，不受这条限制；本地脚本安装请在普通终端里跑。

## 安装

### 从 npm 安装（推荐）

包名 `dsh-guard-native`。在 DSH 里打开 **插件 → 添加插件**，输入包名并确认；或在终端运行
`dsh plugin --profile desktop add dsh-guard-native`，然后重启 DSH。它按普通 bundle 安装：包进入
`dsh.profile.bundles`，加载器应用包内的 `cordis.patch.yml`，客户端由宿主以
`/plugins/dsh-guard-native/client.js` 提供，无构建步骤。**仅 Windows**（它守的是 `pwsh` 执行器）。

想在社区索引里发现它：打开 **插件 → 实验性插件 → 自定义插件索引**，在 **发现 → 添加索引源** 里加你信任的索引
（例如 Open Plugin Market 的 `https://dshopen.org/index.json`）。

### 从源码安装（本地脚本）

```powershell
# 在项目根目录，用普通（非 dsh 内的）PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

`cmd.exe` 下也可以：

```bat
scripts\install.cmd
```

安装器依次做这些事：

1. 解析 profile（默认 `%USERPROFILE%\.dsh\profiles\desktop`，用 `-ProfileDir` 改）。
2. 拷贝 `lib\index.mjs` → `<profile>\dsh-guard-native.mjs`。
3. 写 `<profile>\dsh-guard.json`（有效配置的可读镜像）。
4. 在 `<profile>\cordis.patch.yml` 里**新增或更新唯一一条**条目，配置**内联**：

   ```yaml
   - insert:
       - id: guard-native
         name: "./dsh-guard-native.mjs"
         config:
           enabled: true
           gating: true
           statusLine: true
           workspace: ""
           dshHome: "C:\\Users\\you\\.dsh"
           stateDir: "C:\\Users\\you\\.dsh\\emergency"
           auditLog: "C:\\Users\\you\\.dsh\\emergency\\guard-audit.jsonl"
           loadMarker: "C:\\Users\\you\\.dsh\\profiles\\desktop\\dsh-guard-native-loaded.txt"
           protectedRoots: [ "C:\\Users\\you", "C:\\" ]
   ```

   条目用**相对路径**（这是该加载器确实能加载的形式）；name 用双引号，配置里的 Windows 反斜杠只需 `\\`。
5. 把 `cordis.patch.yml` 与已存在的模块备份成 `*.bak-<时间戳>`。
6. **校验写入结果**：模块哈希与源一致、条目存在、配置能被 JSON 解析、补丁文件仍然是结构正确的 YAML 数组；若本机有 `node`，顺带跑一遍离线自测。
7. 打印回滚命令，并提示你**重启 dsh**。

常用参数：

| 参数 | 作用 |
|---|---|
| `-DryRun` | 只打印将写入的配置、条目与补丁文件全文，**不写任何东西**。 |
| `-Status` | 只读报告：条目、文件、哈希、装载回执、开关、台账行数。 |
| `-Uninstall` | 移除条目与拷贝的文件。**台账与开关不会被碰。** |
| `-ProfileDir <路径>` | 装到别的 profile。 |
| `-Workspace <绝对路径>` | 设置兜底工作区。不设则每次调用用所在会话自己的 cwd。 |
| `-ProtectedRoots <a>,<b>` | 受保护根：这些根下"非具名单文件"都算大范围。 |
| `-Gating false` | 影子模式：照常判定与记账，但一律放行。 |
| `-StatusLine false` | 不注入会话状态行。 |
| `-EmergencySwitches DISABLE` | 预创建开关文件（见下）。 |
| `-UseConfigFile` | 条目里只写 `configFile: <json>`，配置放在 `dsh-guard.json`；内联字段仍逐字段优先。 |

**然后重启 dsh**：加载器只在启动时读一次补丁层。

## 验证安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Status
```

应当看到 `patch entry present`、`same revision as this source tree`，以及 `last load:` 的时间晚于你这次重启。之后在 dsh 里开一个会话，看首行状态：

```
dsh-guard active (...). workspace: F:\work\my-project (this session's own cwd). emergency switches: none. audits: 12 total, ...
```

`workspace:` 就是**该会话**每次调用被判定的根；若显示 `configured fallback`，说明该会话没有暴露 cwd，用了你配置的兜底值。

两条快速行为验证：

| 操作 | 预期 |
|---|---|
| 读文件、带通配符列目录、`git status` | 不弹窗 |
| `Remove-Item -Recurse -Force .\out` | 弹一次，首行 `dsh-guard: BULK DELETES paths inside this project workspace` |

## 配置

所有键都可省略，默认值就是安装器写入的那些。

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 置 false 仍写装载回执与状态行，但完全不拦。 |
| `gating` | boolean | `true` | 置 false 为影子模式：照常判定记账，一律放行。 |
| `statusLine` | boolean | `true` | 会话创建时注入一行状态。 |
| `workspace` | 绝对路径 | `""` | **仅兜底**。每次调用按所在会话的 `cwd`（`SessionHeader.cwd`）判定；只在会话没暴露 cwd 时才用这个值。 |
| `dshHome` | 绝对路径 | `%USERPROFILE%\.dsh` | 决定后三项的默认值。 |
| `stateDir` | 绝对路径 | `<dshHome>\emergency` | 三个开关文件所在目录。 |
| `auditLog` | 绝对路径 | `<stateDir>\guard-audit.jsonl` | 台账。 |
| `loadMarker` | 绝对路径 | `""`（关闭） | 每次 `apply()` 追加的装载回执；状态路由的失败痕迹写在它旁边。 |
| `protectedRoots` | 路径数组 | 你的用户目录与 `C:\` | 这些根下"非具名单文件"即视为大范围。 |
| `configFile` | 绝对路径 | 未设 | 从该 JSON 读配置；内联键逐字段优先。 |

改配置：编辑 `<profile>\cordis.patch.yml`（或 `-UseConfigFile` 安装时的 `dsh-guard.json`），然后**重启 dsh**。只改插件正文同样需要重启，因为模块在启动时被 import。

## 怎么用

### 三种回答

| 决定 | 面板表现 | 你该做什么 |
|---|---|---|
| **allow**（静默） | 什么都不显示 | — |
| **ask** | 一句分类 + 命中规则 + 精确目标 | 看 `target:` 那行；范围就是你要的就批准，否则拒绝并说明真实意图。 |
| **deny** | 同样内容，前缀 `DENY`，带 `NOT executed` | 命令没执行，重试也不会执行，换做法。 |

### 怎么读一次升级

固定顺序回答四个问题：

1. **做什么 + 落在哪**（首行分类）：`BULK DELETES paths OUTSIDE this project workspace`、`批量改写（本工作区内）`。动作类别：删除 / 改写 / 新建 / 复制 / 解包 / 改权限 / 改属主属性 / 回退 / 间接执行 / 格式化 / 未识别；单个 vs 批量；区内 vs 区外。
2. **`decision:`**：是否已执行。`DENY` 写 `NOT executed`，`ask` 写 `has NOT run`。
3. **`workspace:`**：判定用的根，以及它来自会话还是配置兜底。
4. **`rule:` 与 `target:`**：证据——命中的模式（带人话解释）与命令/路径原文，截断到 200 字符。

### 怎么减少弹窗

| 症状 | 处理 |
|---|---|
| 合法的批量任务每次都问 | 批准即可。守卫**故意不设 allow-list**，按次判定。 |
| 一整类工作总被问（如解包） | 用影子模式 `-Gating false`（照常记账不问），或收窄 `protectedRoots`。 |
| 现在就想让它别挡路 | 建 `DISABLE` 开关（一个文件，**不需重启**）。 |
| 想留记录但不要弹窗 | 影子模式 + 读 `guard-audit.jsonl`。 |

## 能观察到什么

| 观测面 | 位置 | 内容 |
|---|---|---|
| **会话状态行** | 对话里，每会话一次 | 姿态、生效的工作区根、开关、审计计数、最近一条值得注意的判定 |
| **审批弹窗** | 面板，升级时 | 一句话分类；完整原因在工具卡里 |
| **会话事件** | 会话日志的 `approval/asked` | 当时真正展示给用户的完整文案（可回溯） |
| **`/dsh-guard/status`** | `http://127.0.0.1:19387/dsh-guard/status`（`?format=json` 取 JSON） | 按需报告：姿态、装载时间/pid/node、工作区模型、审计计数、本进程判过的会话、规则清单、各可见面的边界 |
| **台账** | `<stateDir>\guard-audit.jsonl` | 每次判定一行 JSON |
| **状态脚本** | `scripts\status.ps1`（安装为 `dsh-guard-status.ps1`） | 命令行版同一份报告；`-Json` 供机器读 |

一行台账示例：

```json
{"ts":"2026-10-16T02:26:28.948Z","session":"session-3a3bfc97…","tool":"pwsh","decision":"ask",
 "action":"overwrite","mass":true,"scope":"inside","summary":"批量改写（本工作区内）",
 "rule":"ps-wildcard-write, wildcard-target","rules":["ps-wildcard-write","wildcard-target"],
 "workspace":"F:\\work\\my-project","workspaceSource":"session","externalTargets":[],
 "sandbox":"","justification":"","preview":"Set-Content -Path .\\out\\*.log -Value \"\""}
```

**没有设置页区块**，这是平台约束而非偷懒：`settings.section` 是**客户端** slot，客户端贡献必须带已构建的 `lib/client.js`，由宿主以 `/plugins/<包>/client.js` 提供；profile 里的本地模块注册不了。上面的状态页就是官方支持的按需入口。

## 三个紧急开关

状态目录（默认 `%USERPROFILE%\.dsh\emergency`）里的文件。**新建/删除即生效，不需要重启。** 它们在会话工作区之外，所以会话写不进去。

| 开关 | 作用 |
|---|---|
| `DISABLE` | 停止判定：一律放行。状态行会显示 `WARNING: dsh-guard is DISABLED`，而不是假装在场。 |
| `PANIC` | 硬拦降级为询问，让你批准一次确实需要的无界删除。 |
| `HARD-STOP` | 所有升级一律硬拦，**包括升权地板**。 |

```powershell
$s = "$env:USERPROFILE\.dsh\emergency"
New-Item -ItemType File "$s\PANIC"        # 允许我批准一条平时被硬拦的命令
New-Item -ItemType File "$s\DISABLE"      # 完全停止闸门
New-Item -ItemType File "$s\HARD-STOP"    # 一律不批
Remove-Item "$s\PANIC"                    # 恢复默认
```

## 判定分层

依次四层：

1. **工具范围**：只判 `pwsh` 与 `write`；`read` / `glob` / `grep` / `edit` / web / 子代理工具直接放行（`edit` 只能改本会话已读过的文件，且有文件沙箱与版本快照兜底）。
2. **只读不问**：命令里没有任何修改性动词 ⇒ 放行。这一层让通配读、目录列举、`rg` 保持安静。
3. **规则表**：先算批量信号（递归、通配、管道批处理、递归拷贝、解包、整树回退、间接外壳、无界目标），再算范围（是否有目标落在会话工作区之外、也在 dsh home/状态目录之外）。
4. **升权地板**：请求沙箱让开的调用，在"删除 / 大批量改写"这类越界形态上升级。

`write` 与命令行分开判：文件路径不是 shell 命令，所以**路径永不被当作动词扫描**（曾经 `README.md` 里的 `md` 命中 `md` 别名，把一次读判成"批量新建"）。write 按磁盘实际情况分类：首次新建，或覆盖已有文件。

## 更新与卸载

**更新（npm 安装）**——在 **插件 → 已安装** 里，registry 上的新版本会显示 **有可用更新**，点更新即可替换；
或运行 `dsh plugin --profile desktop add dsh-guard-native` 后重启 DSH。DSH 会向 npm registry 检查
registry 安装副本的新版本，所以更新不必等索引重新发布。

**更新（源码安装）**——替换 `lib\index.mjs` 为新版本，然后：

```powershell
node test/matrix.mjs                                                              # 可选，离线
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Status  # 先看差在哪
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1          # 安装
# 重启 dsh
```

先 `-Status` 能告诉你"部署的模块是否等于你手上的这一版"，更新不再是猜。

**卸载（npm 安装）**：在 **插件 → 已安装** 里移除该 bundle，然后重启 DSH。

**卸载（本地脚本安装）**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Uninstall
# 重启 dsh
```

会移除补丁条目与拷贝过去的模块、配置、状态脚本；**台账、开关与备份一律保留**，要清自己删。

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| 状态行从不出现 | 条目没被加载。先 `-Status`，再看装载回执（`<profile>\dsh-guard-native-loaded.txt`）——没有新的 `loaded_at` 段就说明加载器没接受该条目。确认 `cordis.patch.yml` 里是 `name: "./dsh-guard-native.mjs"`（相对、带引号）。 |
| 装完 dsh 起不来 | 回滚：`Copy-Item '<profile>\cordis.patch.yml.bak-<时间戳>' '<profile>\cordis.patch.yml' -Force`，再删 `<profile>\dsh-guard-native.mjs`。 |
| `/dsh-guard/status` 返回 404 | 插件 apply 时宿主没有 web carrier，或注册被拒。看 `<profile>\dsh-guard-native-status-route.txt`——注册失败会留痕。 |
| 连读操作都被问 | 装的是旧版本。`-Status` 看哈希，重新安装。 |
| 什么都不问了 | 有 `DISABLE` 开关、`gating` 为 false、或 `enabled` 为 false。状态行会说明是哪种。 |
| 改了配置没生效 | 加载器只在启动时读补丁层：重启 dsh。用 `-UseConfigFile` 时注意内联键逐字段优先。 |
| 状态脚本与状态页数字不一致 | 脚本统计**整个台账文件**（含历次进程与更早版本），状态页只统计**本进程**写的行；两边都报总数，对照着看即可。 |

## 如实说明的限制

- **它读的是文本，不是意图。** 通过脚本文件、编译好的二进制、或它不认识的运行时执行的删除可以溜过。它认识常见文件改写 API（`fs.writeFileSync`、`shutil.rmtree`、`unlinkSync` 等）从而扩大覆盖面，但这仍是**语义闸门，不是沙箱**。请继续开着文件沙箱：守卫负责"不可逆的事发生前有人点头"，不负责限制爆炸半径。
- **引用危险模式也会被拦。** 它分不清"执行"与"谈论"：命令文本里**字面包含** `rm -rf /` 或 `Format-Volume` 就会被硬拦。测试命令里请避免这种字面量，或临时加 `PANIC`。
- **宁可误报，不可漏报。** 带修改性动词名字的只读命令会被升级，而不是放行。
- **`edit` 不在闸门内。** 它只能改本会话读过的文件；那边靠文件沙箱与你的版本快照。
- **没有 allow-list。** 批准只对当次有效，同样的模式下次仍会被判定。
- **台账是文件不是服务。** 用得多就变大，需要轮转请自行处理。
- **面向 Windows。** 规则与安装器都按 Windows 的 PowerShell/cmd 形态设计。

## 开发

```powershell
node test/matrix.mjs      # 238 项离线自检：规则矩阵、开关、工作区解析、动作分类、
                          # 只读静默、别名陷阱、升权地板、升级文案、状态面、装配
node scripts/sync-source.mjs --check    # 本目录与工作区副本是否同步
node scripts/sync-source.mjs --write    # 工作区 -> 本项目
```

自测用纯 Node 运行、注入假 `readPath`、不碰真实磁盘。**改任何规则都必须重跑它。**

目录结构：

```
lib/index.mjs            插件本体：单文件、零第三方依赖的 ESM
config.schema.mjs        配置形状、默认值与校验器
scripts/install.ps1      安装 / 更新 / 状态 / 卸载（识别 profile、幂等、写入后自校验）
scripts/status.ps1       按需状态报告（只读；-Json 供机器读）
scripts/install.cmd      cmd.exe 包装
scripts/sync-source.mjs  本项目与开发工作区之间的显式同步
test/matrix.mjs          离线自测矩阵
docs/ARCHITECTURE.md     闸门怎么实现、为什么，以及塑造它的那些缺陷
CHANGELOG.md             版本历史
```

MIT 许可，见 [LICENSE](LICENSE)。
