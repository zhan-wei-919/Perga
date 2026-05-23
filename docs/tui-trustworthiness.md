# TUI 基础可信度

这份文档定义 Perga 在成为日常主力终端之前必须守住的 TUI 体验底线。这里的
TUI 指 `vim`、`tmux`、`lazygit`、`htop`、`fzf`、`less`、`claude` 这类直接
占用终端 viewport、依赖终端格子语义和输入协议的程序。

“基础可信度”不是功能丰富度,而是用户运行这些程序时不会怀疑终端本身。只要
画面错位、鼠标不工作、复制不可靠、resize 后残影、输入组合键被前端吞掉,
用户就会把问题归因到 Perga,并回到成熟终端。

## 产品定位

Perga 不需要在第一阶段追平 WezTerm 的全部通用终端能力。当前更重要的目标是:

1. 桌面端本地 PTY 可作为日常终端使用。
2. iPad / Android 端远程 SSH 可作为真实开发入口使用。
3. Web-native UI 的主题、分屏、profile、未来命令块 / AI 工作流不能破坏传统
   终端的基本契约。

因此 TUI 基础可信度是移动端 SSH 场景的前置条件。平板端如果连 `vim`、`tmux`
和 `lazygit` 都不稳定,更上层的触控 UI 和 profile 管理没有意义。

## 可信度边界

### 1. 格子语义正确

终端 UI 的最低层是固定 cell grid。Perga 的 DOM 渲染可以用现代 Web 技术实现,
但表现必须等价于终端格子:

- CJK 宽字符、emoji、组合字符、box drawing、下划线、粗体、斜体、反色不能
  破坏列宽。
- 光标必须落在后端终端状态给出的 cell 上,不能受 DOM flow、字体 fallback 或
  letter spacing 影响。
- alternate screen 进入 / 退出必须正确:`vim` 退出后恢复原 shell 画面。
- resize 后后端 PTY size、前端 measured rows/cols、DOM grid 三者必须一致。

失败信号:

- TUI 边框断线、横线和竖线不接。
- prompt 或输入光标和 `$` 之间出现非预期空白。
- `vim` / `less` 退出后残留全屏内容。
- 缩放或窗口 resize 后 TUI 多出空列、错行或残影。

### 2. 输入协议完整

终端用户默认认为特殊键和组合键是可靠的。前端可以拦截 Perga 自己的快捷键,
但必须有清晰边界:

- `Ctrl+C`、`Ctrl+Z`、`Ctrl+D`、`Esc`、`Tab`、方向键、Home/End、PageUp/PageDown
  必须能进入 PTY / SSH。
- `Alt` / `Meta` 组合键不能被浏览器或自定义 UI 随意吞掉。
- Perga workspace 快捷键只在明确命中时拦截;未命中的键必须交给终端。
- paste 需要走 bracketed paste,避免多行粘贴被 shell 当成逐行输入立即执行。
- IME composing 阶段不能发送半成品按键。

失败信号:

- `vim` 里 `Esc`、`Ctrl+[`、`Alt` 组合键异常。
- Android / iPad 外接键盘的快捷键和桌面不一致。
- 粘贴多行命令时发生非预期执行。
- 前端复制快捷键误发 SIGINT,或 SIGINT 被复制逻辑吞掉。

### 3. 鼠标上报可信

TUI 程序开启 mouse reporting 后,鼠标默认应该属于 TUI,而不是前端 selection。
这要求前端把 pointer / wheel 事件转换成终端 cell 坐标,再按后端当前 terminal
modes 编码发送。

最低要求:

- `vim` 点击定位、滚轮滚动。
- `tmux` 点击 pane、拖动分隔线。
- `lazygit` / `htop` 点击菜单或列表。
- TUI mouse reporting 关闭时,鼠标回到前端选择复制。
- TUI mouse reporting 开启时,保留一个强制前端选择的修饰键路径,例如
  `Shift+Drag` 或 `Alt+Drag`。

失败信号:

- `vim` / `tmux` 明明开启 mouse,点击没有反应。
- 用户想复制文本,却误触发 TUI 操作。
- 用户想操作 TUI,却被前端 selection 覆盖。

### 4. 选择复制可靠

Perga 不能长期依赖浏览器原生 selection 作为终端选择模型。终端选择应该基于
cell grid,而不是 DOM 文本流。

最低要求:

- 支持跨行选择。
- 支持矩形选择,用于复制表格列。
- 复制时去掉行尾无意义填充空格,但保留用户可见的真实空格。
- 选择高亮由 Perga 自己绘制,不受 DOM span 拆分影响。
- TUI mouse reporting 与前端 selection 有确定优先级。

失败信号:

- 复制出来的内容多了列填充空格。
- CJK / emoji 附近选择范围错位。
- 鼠标扫过的高亮区域和最终复制文本不一致。
- TUI 中无法区分“拖拽选择”和“拖拽操作程序”。

### 5. Scrollback / 搜索 / Copy Mode

成熟终端的用户会默认依赖历史查看和键盘复制。Perga 至少需要提供:

- scrollback 行数达到配置上限前持续增长。
- 超过上限时行为明确,不能因为后端计数饱和导致历史停止增长。
- `Ctrl+F` / `Cmd+F` 等搜索入口。
- 键盘 copy mode,允许不用鼠标在历史中移动、选择和复制。
- quick select 类能力可后置,但 URL / path / git hash 这类高频复制目标最终需要覆盖。

失败信号:

- `cat` 大文件后历史停止更新。
- 用户无法搜索过去输出。
- 远程平板场景下没有鼠标时无法复制历史内容。

### 6. 高频刷新稳定

TUI 可信度不是平均帧率,而是高吞吐和交互同时发生时的尾延迟。`top`、`htop`、
`vim` 快速滚动、`cat` 大文件、后台 tab 噪声输出都可能暴露问题。

最低要求:

- 前台 pane 输入延迟 p99 稳定低于一帧预算。
- DOM render RAF p99 留出足够余量,不要把 16.7ms 帧预算吃满。
- 后台 tab / pane 的高频输出不能明显拖慢当前交互 pane。
- resize / zoom 不触发持续全量重排。

失败信号:

- `cat` 大文件时键盘输入明显滞后。
- 后台 `tail -f` 影响前台 `vim`。
- 每个 patch 都触发布局测量或全屏重绘。

### 7. SSH 场景不降低 TUI 能力

Perga 的移动端核心是远程 SSH,所以 SSH session 内的 TUI 能力必须和本地 PTY
尽量一致。

最低要求:

- SSH PTY size 与前端 resize 同步。
- SSH session 支持 mouse、paste、focus、resize 等同一套输入事件。
- SSH 认证失败、断线、profile 错误要显示明确原因,不能表现为空白终端。
- SSH 下的 shell integration 可以后置,但普通 TUI 行为不能依赖 shell integration。

失败信号:

- 本地 `vim` 正常,SSH `vim` 键鼠异常。
- 远程断线后用户不知道是网络问题、认证问题还是程序 bug。

## 与 WezTerm 的差距

WezTerm 在通用终端方向已经覆盖大量成熟能力:mouse reporting、searchable
scrollback、copy mode、quick select、SSH channel 复用、remote mux、Lua 配置、
字体 fallback、图片协议、跨平台发布等。

Perga 不应该短期逐项追平。更合理的策略是先把移动端 SSH 和 Web-native UI
不会破坏传统终端契约这件事做扎实,再逐步补成熟终端长尾。

## 建议优先级

### P0: 阻断日常 TUI 使用

1. 前端 mouse reporting。
2. selection model 与 TUI mouse 优先级。
3. resize / zoom / font fallback 下的格子一致性测试。
4. SSH session 错误提示和断线状态。

### P1: 影响替代成熟终端

1. scrollback search。
2. keyboard copy mode。
3. key file / passphrase / keyboard-interactive SSH auth。
4. 后台 tab dispatch 暂停或合并。
5. IME 与移动端软键盘。

### P2: 成熟终端长尾

1. quick select。
2. hyperlink。
3. 图片协议(iTerm2 / Kitty / Sixel)。
4. 远端 mux / session restore。
5. 用户可编程配置或更完整的快捷键配置。

## 验收清单

每次改动终端渲染、输入、selection、resize、SSH transport 后,至少用下面程序
手测一遍:

- `vim`:编辑、Esc、搜索、鼠标点击、滚轮、退出恢复。
- `tmux`:分 pane、切 pane、鼠标点击、resize。
- `lazygit`:键盘导航、鼠标点击、滚动。
- `htop` 或 `top`:持续刷新时输入延迟。
- `less`:搜索、滚动、退出恢复。
- `fzf`:快速输入、方向键、选择。
- `cat` 大文件:scrollback、选择复制、输入延迟。

自动化方向:

- 用 raw protocol fixture 覆盖 box drawing、CJK、emoji、wide spacer、alternate
  screen、resize。
- 用浏览器 autotest 记录 dispatch、render RAF、first patch、command_end 延迟。
- 用 in-process SSH server 覆盖 SSH round-trip、resize、paste、mouse。
- 用 Playwright 截图或 DOM 序列化 helper 检查 cell 对齐和 selection overlay。

## 非目标

以下不属于 TUI 基础可信度的第一阶段:

- 完整 Lua 级可编程配置。
- 所有图片协议。
- serial port。
- 远程 mux 持久 session。
- 商店级发布和自动更新。

这些能力重要,但它们是在“终端基础可信”之后才会影响产品上限;在此之前追它们
会稀释最关键的可信度工作。
