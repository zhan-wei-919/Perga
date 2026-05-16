# Web 原生终端架构技术设计

## 背景

这个项目要做的不是传统意义上把 VT100/xterm 终端照搬到 Web 里，而是一个以 Web 前端为主要交互层、Tauri 为桌面容器、Rust 后端接管 PTY 和终端协议解析的新形态终端。

核心约束是：PTY 里的程序仍然按照 xterm/VT 系列终端协议输出字节流。即使前端最终呈现出更现代的 block、rich output、结构化命令历史或可视化 UI，后端仍然需要一个足够可靠的终端 emulator core 来维护真实终端状态。

## 目标

- 后端负责创建 PTY、启动 shell/命令、读取 PTY 输出、解析终端协议、维护终端状态，并向前端发送规范化数据。
- 前端负责接收用户输入、呈现终端状态、管理选择/复制/搜索/滚动/交互，并把输入事件发送给后端。
- TUI 程序走兼容路径，保持 cell grid 语义正确，支持 vim、tmux、top、fzf 等依赖光标定位和局部重绘的程序。
- 普通命令输出和新形态内容走 block 路径，允许用 Web 原生布局、富文本渲染和 `@chenglou/pretext` 做高性能排版。
- 后端协议保持稳定、可版本化、可回放，方便调试解析问题和前端渲染问题。

## 非目标

- 不在第一阶段自研完整 VT/xterm parser。
- 不把终端字节流直接交给前端解析。
- 不把所有输出都强制转换成高级 UI 组件。
- 不为了视觉增强破坏终端原始 cell grid 语义。
- 不把 `@chenglou/pretext` 用作 TUI grid 的替代品。

## 总体架构

```text
Tauri App
  Rust Backend
    PTY Manager
      shell / command / child process
    Terminal Engine Adapter
      alacritty_terminal
      terminal grid / modes / cursor / scrollback / damage
    Protocol Encoder
      normalized events / snapshots / diffs
    Input Encoder
      semantic input event -> terminal bytes

  Web Frontend
    Session Store
      snapshots / diffs / scrollback / blocks
    Grid Renderer
      TUI compatibility / cell grid / cursor / selection
    Block Renderer
      command output / semantic blocks / Pretext layout
    Input Controller
      keyboard / mouse / paste / IME / resize
```

后端是终端状态的事实来源。前端可以有自己的 view model 和渲染缓存，但不能把视觉推断结果反向当成终端语义。

## 数据流

### 输出路径

```text
PTY bytes
  -> alacritty_terminal parser/state update
  -> terminal snapshot/damage extraction
  -> normalized protocol event
  -> frontend session store
  -> renderer update
```

后端读取 PTY 字节后，不做字符串级 escape sequence 检测。所有控制序列都应通过终端 parser 进入终端状态机，再由 adapter 暴露为模式变化、光标变化、grid damage、scrollback 变化等规范化事件。

### 输入路径

```text
keyboard / mouse / paste / resize
  -> frontend semantic input event
  -> backend input encoder
  -> PTY write / resize
```

前端不应该在所有场景下直接拼 terminal escape bytes。原因是后端掌握当前终端模式，例如 application cursor、bracketed paste、mouse reporting、alternate screen 等。前端发送语义输入，后端根据当前模式编码为实际写入 PTY 的字节。

示例：

```json
{
  "type": "key",
  "sessionId": "s1",
  "key": "ArrowUp",
  "modifiers": {
    "ctrl": false,
    "alt": false,
    "shift": false,
    "meta": false
  }
}
```

## 后端设计

### PTY Manager

职责：

- 创建 PTY。
- 启动默认 shell 或指定命令。
- 读取 PTY 输出字节。
- 写入用户输入字节。
- 处理进程退出、异常、窗口尺寸变化。

PTY Manager 不直接理解终端协议，只负责字节流和子进程生命周期。

### Terminal Engine Adapter

使用 `alacritty_terminal` 作为终端核心，但不要把它的内部类型直接泄漏给前端协议。

职责：

- 把 PTY 输出喂给终端核心。
- 维护 main screen、alternate screen、cursor、modes、grid、scrollback。
- 提取 changed rows / damaged cells。
- 暴露稳定的项目内部模型。

关键设计：

- `\x1b[?1049h` 是进入 alternate screen 的强信号，但不能用 raw string `contains()` 检测。
- 同类模式还包括 `?1047h`、`?1048h`、`?1049h` 及其退出序列。
- 有些程序不进入 alternate screen，但仍然使用光标移动、清屏、局部重绘，因此不能只靠 alternate screen 判断是否需要 grid 兼容渲染。
- 后端应暴露当前 screen/modes，而不是暴露原始 escape sequence。

推荐内部状态：

```ts
type TerminalRuntimeMode = {
  screen: "main" | "alternate"
  cursorVisible: boolean
  applicationCursor: boolean
  bracketedPaste: boolean
  mouseReporting: "off" | "x10" | "normal" | "button" | "any"
  focusReporting: boolean
}
```

### Protocol Encoder

后端发送给前端的数据分为三类：

- `snapshot`：完整状态，用于初始化、重连、恢复一致性。
- `diff`：增量更新，用于热路径。
- `lifecycle`：进程退出、错误、尺寸变化确认等非渲染事件。

协议必须包含：

- `version`：协议版本。
- `sessionId`：终端会话。
- `seq`：单调递增序号，前端用来保证顺序。
- `mode`：当前 screen/modes。
- `cursor`：光标位置和显示状态。
- `damage`：变更区域。
- `rows` 或 `cells`：实际变更内容。

示例：

```json
{
  "version": 1,
  "type": "diff",
  "sessionId": "s1",
  "seq": 1281,
  "screen": "alternate",
  "size": { "rows": 36, "cols": 120 },
  "cursor": { "row": 12, "col": 4, "visible": true },
  "modes": {
    "applicationCursor": true,
    "bracketedPaste": true,
    "mouseReporting": "normal"
  },
  "rows": [
    {
      "row": 12,
      "cells": [
        {
          "col": 0,
          "text": "-",
          "width": 1,
          "fg": "#d4d4d4",
          "bg": "#111111",
          "attrs": ["bold"]
        }
      ]
    }
  ]
}
```

### Input Encoder

职责：

- 把前端语义输入转成 PTY bytes。
- 根据当前 terminal modes 选择正确编码。
- 处理 paste、IME、组合键、鼠标事件。

特殊输入：

- bracketed paste 开启时，paste 内容需要包裹对应控制序列。
- application cursor 开启时，方向键编码不同。
- mouse reporting 开启时，鼠标事件需要转成终端协议；关闭时，鼠标事件只作为前端选择/滚动行为。

## 前端设计

### 双渲染路径

前端有两条渲染路径：

- Grid Renderer：终端兼容路径。
- Block Renderer：Web 原生新形态路径。

选择策略不是简单的“是否出现 `?1049h`”，而是由后端 mode、输出特征和前端当前交互上下文共同决定。

推荐规则：

- `screen = "alternate"` 时强制使用 Grid Renderer。
- main screen 中出现频繁光标定位、清屏、局部覆盖时，当前活跃区域使用 Grid Renderer。
- 普通命令输出、历史输出、AI 解释、搜索结果、结构化日志等使用 Block Renderer。

### Grid Renderer

Grid Renderer 以 cell grid 为事实来源。

职责：

- 按行列绘制字符、样式、背景、cursor。
- 支持 selection、copy、search、hit testing。
- 支持全屏 TUI 程序的局部更新。
- 支持 double-width 字符、combining marks、emoji、CJK 宽度等终端字符宽度规则。

视觉增强只能发生在 paint 阶段。

例如后端给出 5 个连续 `-` cell：

```text
-----
```

前端可以在绘制时把它们合批画成一条横线，但底层 view model 仍然必须保留 5 个 cell。这样 copy、selection、cursor 定位、搜索、回放和 diff 都不会被破坏。

禁止把普通连续字符直接改写成语义组件：

```text
"-----" -> { "type": "horizontalLine", "length": 5 }
```

这会把渲染优化变成语义改写，容易破坏终端兼容性。

### Block Renderer

Block Renderer 用于不需要严格终端坐标语义的内容。

适合内容：

- 普通命令输出。
- 命令历史中的静态输出。
- 日志块。
- 搜索结果。
- AI 解释和诊断信息。
- 项目自定义 rich output。

Block Renderer 可以使用 `@chenglou/pretext` 做高性能文本布局。使用方式应遵循：

- 文本稳定时 `prepare` 一次。
- 宽度变化或容器 resize 时多次 `layout`。
- 文本变化时只重新 prepare 变更 block。
- 缓存 key 至少包含文本内容、字体、字号、字重、white-space 策略和容器约束。

`Pretext` 不参与 TUI grid 的坐标计算，也不改写 PTY 输出语义。

## TUI 兼容策略

TUI 兼容的核心原则是：后端终端状态保真，前端 grid 渲染保真，视觉增强不改变 cell 语义。

### 进入兼容路径

强信号：

- alternate screen 开启。
- 光标寻址频繁。
- 清屏后局部重绘。
- mouse reporting 开启。
- application cursor 开启。

弱信号：

- 输出中有大量 box drawing 字符。
- 行内覆盖率高。
- 同一批输出反复修改相同 row/col。

第一阶段可以采用保守策略：

- alternate screen 一律 Grid Renderer。
- 当前活动命令运行期间，如果检测到明显 cursor addressing，即使在 main screen，也把该活动区域固定为 Grid Renderer。
- 命令结束后，再把稳定输出归档为 block，前提是不丢失选择/复制语义。

### 退出兼容路径

退出 alternate screen 或子进程结束后，前端不能立刻丢弃 grid 状态。需要等待后端明确发送：

- `screen = "main"`。
- 新的 diff/snapshot 已经应用。
- 当前活动 TUI 区域可以冻结或销毁。

## Scrollback 与历史

推荐后端维护终端语义上的 scrollback，前端维护渲染缓存和虚拟列表索引。

原因：

- 后端终端核心更接近真实终端行为。
- 前端可以按渲染路径分别缓存 grid rows 和 block layout。
- 后续支持 session replay、恢复和远程同步时，后端状态更容易成为 canonical source。

第一阶段可以简化：

- alternate screen 不进入普通 scrollback。
- main screen 输出进入 scrollback。
- block 化只发生在 main screen 中已稳定的历史输出。

## Resize 策略

前端根据实际容器尺寸计算：

- grid cell width / height。
- rows / cols。

然后发送 resize 请求给后端：

```json
{
  "type": "resize",
  "sessionId": "s1",
  "rows": 36,
  "cols": 120,
  "pixelWidth": 1440,
  "pixelHeight": 864
}
```

后端需要：

- resize PTY。
- resize terminal engine。
- 发送新的 snapshot 或 resize diff。

Block Renderer 的 resize 不影响 PTY rows/cols，只触发前端 `Pretext` layout 重新计算。

## 性能策略

后端：

- 按 PTY read batch 解析。
- 聚合短时间内的 damage，减少前端事件数量。
- 使用 seq 保证事件顺序。
- 避免每个 cell 都发送完整样式，可使用 style table 或 run-length encoding 作为后续优化。

前端：

- Grid Renderer 只重绘 dirty rows 或 dirty regions。
- 连续同样式 cell 合批绘制。
- 视觉增强只在 paint 阶段执行。
- Block Renderer 对稳定文本 prepare 一次，layout 多次。
- 使用虚拟滚动避免历史输出撑爆 DOM。

后续可优化协议：

```json
{
  "styles": [
    { "id": 1, "fg": "#d4d4d4", "bg": "#111111", "attrs": [] }
  ],
  "runs": [
    { "row": 10, "col": 0, "text": "hello", "style": 1 }
  ]
}
```

## 错误处理与恢复

需要处理的失败场景：

- shell 启动失败。
- PTY read/write 错误。
- 子进程退出。
- 前端漏掉 diff。
- 前后端协议版本不匹配。
- resize 频繁触发造成状态抖动。

恢复策略：

- 前端发现 seq 不连续时，请求后端发送 snapshot。
- 后端发生不可恢复错误时，发送 lifecycle event。
- 协议版本不兼容时，前端拒绝应用事件并展示会话错误。
- resize 事件需要 debounce，但最终尺寸必须送达后端。

## 调试与可观测性

建议支持可选 replay 日志：

- raw PTY byte stream。
- normalized protocol events。
- frontend render decisions。

注意 raw PTY 日志可能包含敏感数据，默认关闭，并在 UI 中明确提示。

最有价值的调试能力：

- 用同一份 PTY byte stream 重放后端解析。
- 用同一份 protocol event 重放前端渲染。
- 对比 snapshot 与前端 view model 是否一致。

## 测试策略

后端测试：

- PTY 生命周期测试。
- 输入编码测试。
- terminal modes 测试。
- alternate screen 进入/退出测试。
- snapshot/diff 顺序测试。

前端测试：

- Grid Renderer dirty row 更新测试。
- selection/copy/hit-test 测试。
- Block Renderer resize layout 测试。
- Pretext cache invalidation 测试。
- TUI 模式切换测试。

集成测试：

- `echo`、`ls`、长日志输出。
- `vim` / `nvim`。
- `tmux`。
- `top` / `htop`。
- `fzf`。
- CJK、emoji、combining marks、宽字符。

## 分阶段实现

### 第一阶段：最小可用终端

- Tauri 基础应用。
- Rust 后端创建 PTY 并启动 shell。
- 使用 `alacritty_terminal` 维护 grid。
- 前端实现 Grid Renderer。
- 支持键盘输入、paste、resize。
- 支持 snapshot 和基础 diff。

### 第二阶段：可靠 TUI 兼容

- 完善 alternate screen、mouse reporting、application cursor、bracketed paste。
- 完善 dirty region 和 cursor 更新。
- 加入 TUI 集成测试。
- 加入 replay 调试能力。

### 第三阶段：新形态 block 输出

- 定义命令生命周期和 block 边界。
- 普通 main screen 输出归档为 block。
- 引入 `@chenglou/pretext` 做 block 文本布局。
- 实现 block 虚拟滚动、搜索、复制。

### 第四阶段：视觉增强

- Grid Renderer paint 阶段合批绘制连续线条、box drawing。
- 增强日志、错误、路径、URL 等语义识别。
- 增加自定义 rich output 协议。

## 已确定的技术取舍

- 后端使用完整终端核心维护状态，而不是只解析字符串。
- 前端使用双渲染路径，而不是一套 renderer 处理所有场景。
- TUI 兼容以 cell grid 保真为准。
- `\x1b[?1049h` 是重要信号，但不是唯一分流依据，也不能通过 raw string 检测。
- `@chenglou/pretext` 用于 block/paragraph 布局，不用于替代 TUI grid。
- 视觉增强属于 paint optimization，不进入 canonical terminal model。
- 前端发送语义输入，后端根据当前 terminal modes 编码为 PTY bytes。

## 待确认问题

- Grid Renderer 第一版使用 Canvas 2D、DOM，还是直接 WebGL。
- Scrollback 的长期存储是否需要跨应用重启保留。
- 是否支持多个并发 terminal session。
- 是否需要为自定义 rich output 定义额外的应用层协议。
- 是否需要支持远程 PTY 或 SSH session。
