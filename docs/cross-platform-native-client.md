# Perga 跨平台原生客户端设计

## 目标

Perga 后端 Rust core 保持为终端事实来源,客户端路线从 WebView/Tauri 切换为各平台原生实现。Web/Tauri 客户端已从仓库移除。

核心目标:

- 中文/日文/韩文 IME 使用各平台最可靠的原生输入协议。
- 终端渲染不依赖 Web DOM、textarea、WKWebView 或 Chromium composition 行为。
- Rust PTY、SSH、终端协议解析、grid patch、scrollback、session 管理尽量复用。
- 各平台客户端只负责窗口、输入、渲染、系统集成和可访问性。

非目标:

- 不追求一套 UI toolkit 跑所有平台。
- 不把 WebView 作为终端输入层。
- 不在第一阶段把 Rust core 做成复杂 FFI SDK。

## 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Native Client                                                 │
│                                                              │
│ macOS      Swift/AppKit + NSTextInputClient + Metal/CoreText │
│ iPadOS     Swift/UIKit + hardware keyboard events + Metal    │
│ Android    Kotlin custom View + KeyEvent + Canvas/Skia       │
│ Windows    Win32/WinUI + TSF + DirectWrite/Direct2D          │
│ Linux      GTK4/Qt6 + IBus/Fcitx IM + Pango/HarfBuzz         │
└───────────────────────┬──────────────────────────────────────┘
                        │ IPC
                        │ client -> core: input / resize / mouse / focus
                        │ core -> client: init / patch / command_end / exit
┌───────────────────────▼──────────────────────────────────────┐
│ Rust Core                                                     │
│                                                              │
│ PTY / SSH / terminal parser / grid state / scrollback         │
│ profiles / session lifecycle / bracketed paste / key encode   │
└───────────────────────────────────────────────────────────────┘
```

第一阶段采用 **Rust core 独立进程 + IPC**。这样能最大程度复用当前后端,同时避免每个平台先处理 Rust FFI、线程回调和内存所有权。

后续如果某个平台需要更紧集成,再把 core 抽成 C ABI 或 UniFFI 风格库。

## Rust Core 边界

Rust core 继续负责:

- 本地 PTY 创建、读写和进程生命周期。
- SSH session 和远程 shell。
- terminal escape parsing。
- grid state、dirty row、cursor、modes、title。
- scrollback。
- bracketed paste。
- key/mouse/focus/resize 协议处理。
- profiles、tabs/panes 的数据模型。

Native client 负责:

- 窗口和多窗口生命周期。
- 原生键盘、IME、候选框、marked text。移动端只支持硬件键盘,不支持软键盘。
- 文本/图形渲染。
- 触摸、鼠标、触控板、手势。
- selection、copy/paste、drag and drop。
- 系统菜单、快捷键、通知。
- 可访问性。

Rust core 不直接持有平台 UI 对象。平台事件统一转换为 core input message。

## IPC 协议

先保留现有 wire message 思路,用结构化消息跨进程传输。

Client -> Core:

```text
open_session(profile_id, rows, cols)
close_session(session_id)
resize(session_id, rows, cols)
key(session_id, key, mods)
paste(session_id, text)
mouse(session_id, kind, row, col, mods)
focus(session_id, gained)
set_title/session action/workspace action
```

Core -> Client:

```text
init(session_id, seq, size, cursor, rows, modes, title)
patch(session_id, seq, cursor, dirty_rows, scrolled_rows, modes, title)
command_end(session_id, seq, exit, line)
session_error(session_id, seq, reason)
exited(session_id, seq, status)
```

IPC 传输建议:

- Desktop: Unix domain socket / Windows named pipe。
- Mobile: core 可作为同进程 library,但消息边界仍保持相同。
- 编码:第一阶段可用 JSON 或 MessagePack;性能瓶颈出现后再切二进制。
- 每个 session 的 patch 必须按 `seq` 单调递增,client 丢弃乱序旧帧。

## 平台客户端

### macOS

推荐技术:

- Swift + AppKit。
- 自绘 terminal view 实现 `NSTextInputClient`。
- Metal 或 Core Animation layer 渲染 terminal grid。
- CoreText/HarfBuzz 用于 glyph shaping 和 fallback。

IME 路线:

- 使用 `NSTextInputClient` 的 marked text API。
- `setMarkedText` 更新 preedit。
- `insertText` 提交文本,转换为 `paste` message。
- `firstRect(forCharacterRange:)` 返回终端光标位置,让候选框跟随 cell。

macOS 是优先验证平台,因为当前最大痛点来自 WKWebView IME。

### iPadOS

推荐技术:

- Swift + UIKit。
- 自定义 `UIView` / `UIViewController` 作为 terminal surface。
- Metal 渲染 terminal grid。
- 只支持 Magic Keyboard / Smart Keyboard / 蓝牙键盘等硬件键盘。
- 支持触控选择、外接显示、鼠标/触控板。

键盘路线:

- 使用 `UIKeyCommand`、press event 和 responder chain 处理硬件键盘。
- 普通文本输入转为 `paste` message。
- 控制键、方向键、功能键转为 `key` message。
- iPadOS 第一阶段不弹出软键盘,不实现软键盘文本输入体验。

iPadOS 不应复用 macOS AppKit view,但可复用渲染模型和 IPC client。

### Android

推荐技术:

- Kotlin。
- 自定义 `View` 或 `SurfaceView`。
- Canvas/RenderNode/Skia 或 Vulkan/OpenGL 渲染。
- 只支持原厂键盘 / 蓝牙键盘等硬件键盘。

键盘路线:

- 使用 `KeyEvent`、shortcut dispatch 和 focus system 处理硬件键盘。
- 普通文本输入转为 `paste` message。
- 控制键、方向键、功能键转为 `key` message。
- Android 第一阶段不弹出软键盘,不实现 `InputConnection` / 软键盘 IME。

不要用 WebView 作为 terminal 输入层。Compose 可以用于周边 UI,但 terminal surface 建议先用 custom View。

### Windows

推荐技术:

- C++/Win32 或 WinUI 3 shell。
- DirectWrite + Direct2D/DirectComposition 渲染。
- Text Services Framework (TSF) 处理现代 IME。
- UI Automation 做可访问性。

IME 路线:

- 优先 TSF,不要只依赖 `WM_IME_*`/IMM32。
- composition update 显示 marked text。
- commit string 转为 `paste` message。
- candidate window 位置来自 terminal cursor rect。

Windows Terminal 的方向可作为参考:DirectWrite/DirectX 渲染 + 原生输入栈。

### Linux

推荐技术:

- GTK4 或 Qt6,不要裸 Xlib 起步。
- 渲染使用 GTK snapshot/GL area、Qt scene graph,或共享 wgpu/Skia 后端。
- 文本 shaping 使用 Pango/HarfBuzz。
- 同时支持 Wayland 和 X11。

IME 路线:

- 通过 GTK/Qt 的 input method abstraction 接入 IBus/Fcitx。
- preedit 和 commit 使用 toolkit 的 IM context。
- Wayland 下不要绕过 toolkit 直接写 XIM。

裸 Xlib 会把 XIM、IBus、Fcitx、Wayland、HiDPI、clipboard、selection 全部变成独立坑,不适合作为主线。

## 渲染模型

Rust core 输出 cell grid 和 dirty row。客户端本地维护一份可渲染模型:

```text
SessionView
  size
  cursor
  modes
  active grid rows
  scrollback
  selection
  marked text
```

渲染要求:

- 按 dirty row 更新,不全量重绘。
- 支持 wide glyph、combining mark、emoji、box drawing、block element。
- 支持 font fallback。
- 支持 ligature 策略:默认 terminal cell 对齐优先,不要让 ligature 破坏 cell 宽。
- cursor、selection、marked text 是 overlay,不写回 grid。
- HiDPI 下 cell metric 必须稳定。

可选方向:

- 每个平台先用平台文本 API 做正确性。
- 后续抽共享 renderer,例如 Rust `wgpu`/Skia + 平台输入 shell。

## 输入模型

平台输入统一转成四类:

```text
CommittedText(text)  -> paste
Key(key, mods)       -> key
Mouse(kind, cell)    -> mouse
Focus(gained)        -> focus
```

IME marked text 只在客户端渲染,不发给 core。只有 commit 后才发给 core。

原则:

- 普通文本和 IME commit 都用 `paste` path,复用 UTF-8 和 bracketed paste。
- 控制键才走 `key` path。
- 组合键和应用快捷键先由平台 shell 判断,剩余再发 terminal。
- 不在 core 里理解平台 IME 状态。

## 移动端差异

移动端不是桌面终端缩小版。

iPadOS/Android 当前产品假设是平板配套原厂键盘或蓝牙键盘,因此**只支持硬件键盘输入**。不做软键盘、不做触屏虚拟按键、不做软键盘 IME。

iPadOS/Android 必须额外考虑:

- 触摸 selection handles。
- 长按菜单。
- 硬件键盘快捷键。
- 鼠标/触控板模式。
- 手势缩放字体。
- 后台/前台生命周期。
- 电池和渲染帧率。
- 沙盒文件访问和 SSH key 管理。

移动端第一阶段可以只支持单 pane,等输入和渲染稳定后再做复杂布局。

## 仓库结构建议

```text
crates/
  perga-core/              # session/profile/workspace domain
  terminal-engine/         # terminal parser/grid
  terminal-input/          # key/mouse encoding
  perga-core-daemon/       # IPC server, desktop first

clients/
  macos/                   # Swift/AppKit
  ipad/                    # Swift/UIKit
  android/                 # Kotlin
  windows/                 # C++/Win32 or WinUI
  linux-gtk/               # GTK4

protocol/
  schema/                  # shared IPC schema
  fixtures/                # golden patch/input fixtures
```

Web/Tauri client 不再保留为实验客户端,也不再作为终端输入体验的目标实现。

## 迁移顺序

1. 固化 core IPC 协议和 golden fixtures。
2. 抽出 `perga-core-daemon`,提供桌面原生客户端可复用的 IPC server。
3. 做 macOS Swift/AppKit prototype:
   - 打开本地 shell。
   - render init/patch。
   - 支持 keyboard/IME/paste/resize。
   - 验证中文 `nihao -> 你好`、候选框跟随、preedit。
4. 做 Windows prototype:
   - TSF commit/preedit。
   - DirectWrite grid。
5. 做 Linux GTK4 prototype:
   - IBus/Fcitx preedit/commit。
   - Wayland/X11 clipboard。
6. 做 iPadOS prototype:
   - 硬件键盘输入、快捷键、触控选择。
7. 做 Android prototype:
   - 硬件键盘 `KeyEvent`、快捷键、触控选择。

每个平台 prototype 只做单 tab 单 pane,确认输入和渲染正确后再恢复 workspace 功能。

## 测试策略

Core:

- terminal parser golden tests。
- patch sequence tests。
- UTF-8 split byte tests。
- bracketed paste tests。
- key/mouse encoding tests。

Client:

- 渲染 golden screenshot。
- IME 手工验收 checklist。
- IPC replay:用固定 patch log 驱动客户端渲染。
- 输入 replay:平台事件转换成统一 message 后校验。
- 性能:大输出、scrollback、resize、font fallback。

IME 手工 checklist:

- 中文拼音 `nihao -> 你好`。
- 候选选择不多空格。
- preedit 在 cursor 位置。
- 候选框跟随 cursor。
- 日文假名/汉字转换。
- 韩文组合。
- emoji 和宽字符。
- 删除 composition。
- 桌面 IME。
- iPadOS/Android 硬件键盘输入和快捷键。

## 决策

Perga 的长期方向是:

```text
Rust core unchanged in responsibility
+ platform-native clients for best IME/rendering integration
+ shared IPC protocol as the stable boundary
```

优先级:

1. macOS Swift/AppKit,验证原生 IME 可以彻底解决当前 WKWebView 问题。
2. 固化 IPC 和 replay tooling,避免每个平台重复调 core。
3. Windows/Linux desktop。
4. iPadOS/Android mobile。
