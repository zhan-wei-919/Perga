# Perga 代码规范

## 项目概览

Perga 是一个以 Web 前端为主要交互层、Tauri 为桌面容器、Rust 后端接管 PTY 和终端协议解析的新形态终端。架构细节见 [`docs/web-terminal-architecture.md`](docs/web-terminal-architecture.md)。

后端是终端状态的事实来源,前端不解析终端字节流。

## 运行时模型

后端 PTY / 终端引擎层使用 **sync 线程 + `crossbeam-channel`**,不引入 tokio runtime。

理由:

- PTY 在 Unix 上是阻塞 fd,`alacritty_terminal` 本身也是同步的,套 async 等于绕一圈又回到线程。
- Alacritty 与 WezTerm 都采用「每个 PTY 一个 reader 线程」的模型,session 数量级远未到需要 M:N 调度的程度。
- Tauri 的 `emit` / `Manager` 线程安全,从任意 sync 线程调用即可,不需要 async 上下文。
- 避开 `Send + 'static` over `.await` 的 borrow checker 摩擦。

允许的例外:

- Tauri command handler 可以写成 `async fn`,内部通过 channel 与 PTY 线程通信。
- 后续若引入 SSH / 远程 PTY 等 tokio-based crate,可单开一个小型 tokio runtime 作为 side pool,**不污染核心 PTY / 引擎路径**。

## 注释规范

注释解释**为什么**,不解释**做什么**。自解释代码不写注释。

- 每个模块和 public 函数必须有简短文档注释,说明它的职责。
- 非显然逻辑必须有行内注释。
- 注释用中英文混合。

## 单一职责

每个文件和每个函数只做一件事。

- **函数**:一个清晰目的,尽量控制在 50 行以内。有多个逻辑步骤时拆成私有函数。
- **文件**:一个类型,或一组高度相关的类型。300 行是参考线,不是硬限制。文件明显混入多个职责时必须拆分。
- **`mod.rs`**:只放模块声明和 re-export,不放业务逻辑。

避免把所有文件平铺在一个目录下,按领域分组。

## 数据模型优先于特殊情况

追求更纯粹、更通用的数据模型。添加 `if` 分支或特殊情况之前,先问:**能不能调整模型,让这个特殊情况自然消失?**

```rust
// BAD: 为 empty input 单独分支
fn select_candidates(workers: &[Worker]) -> Vec<Candidate> {
    if workers.is_empty() {
        return Vec::new();
    }
    workers.iter().map(Candidate::from).collect()
}

// GOOD: 通用路径自然处理 empty input
fn select_candidates(workers: &[Worker]) -> Vec<Candidate> {
    workers.iter().map(Candidate::from).collect()
}
```

当特殊情况看起来不可避免时,通常说明抽象不够好。优先修正抽象,而不是在下游补丁式处理。

## 不为未来写代码

只为当前版本已经进入工作面的真实问题写处理逻辑。不要为未来可能出现、但当前系统还没有真实路径触发的问题,提前加入兼容、迁移、兜底、重试或扩展适配代码。

添加这类逻辑前,先确认:

- 当前版本是否真的会产生这个输入、状态或旧数据。
- 是否有测试、真实运行数据或明确协议/存储契约证明它必须处理。
- 这个处理是否属于当前功能的最小闭环,而不是未来功能的影子实现。

如果答案是否定的,把结论记录在设计文档或 `TODO.md`(见下一节),不写进生产代码。

## 延后工作:TODO.md

仓库根的 [`TODO.md`](TODO.md) 是延后工作的活动清单:打了 stopgap 的实现、留下的已知限制、绑定某个未来阶段的后续项。

「不为未来写代码」要求把延后的结论记录下来 —— TODO.md 就是这个落点。当你**有意**用一个不完整的方案换取当前闭环时,在 TODO.md 加一条,而不是在生产代码里提前写未来逻辑。

每条目包含:现状(stopgap 是什么)、已知偏差、触发条件(什么时候回来做)、涉及文件。stopgap 代码里也放一行注释指回 TODO.md,让读代码的人知道这是已记录的延后项。

做完一条就**删**一条,git 历史保留痕迹。

TODO.md 不是 phase 规划 —— 阶段计划在 `docs/state-*.md` 快照里;TODO.md 只放「当前代码里明知不完整、将来要补」的具体条目。

## 边界验证

数据验证只在数据产生或进入系统的边界做一次。下游代码信任已经验证过的类型。

```rust
// GOOD: TaskName 在构造时验证,内部逻辑直接信任
impl TaskName {
    pub fn parse(raw: &str) -> Result<Self, TaskNameError> {
        if raw.trim().is_empty() {
            return Err(TaskNameError::Empty);
        }
        Ok(Self(raw.to_owned()))
    }
}

// BAD: 下游重复修补非法状态
fn schedule(task_name: String) {
    let task_name = task_name.trim();
    if task_name.is_empty() {
        return;
    }
}
```

适用于所有外部输入:在入口处解析、验证、转成干净的强类型,然后向内传递。

## 不可变优先

- 能用 `&self` 就不用 `&mut self`。
- 必须 mutation 时,把可变作用域压到最小。
- 状态迁移通过显式方法表达,不直接散落修改字段。

```rust
// GOOD: 状态迁移集中表达
let attempt = attempt.mark_running(now)?;

// BAD: 任意位置直接改字段
attempt.state = AttemptState::Running;
```

## 错误处理

- Public API 返回 `Result<T, E>`,错误类型应是领域错误,不直接泄漏底层实现。
- 内部不变量使用 `debug_assert!`,只检查理论上不应失败的条件。
- 配置错误、协议错误、认证错误、状态迁移错误必须有明确错误类型。
- 不能静默吞错。至少记录结构化 warn,并带上关键上下文。
- 不用 `unwrap()` / `expect()` 处理可恢复错误。只在进程启动阶段验证不可恢复前置条件时允许 `expect()`,并给出清晰诊断。

日志使用结构化上下文:

```rust
tracing::warn!(
    worker_connection_id = %worker_connection_id,
    attempt_id = %attempt_id,
    error = %error,
    "attempt.finalize_failed"
);
```

## 不过度兜底

错误处理不是「让程序不崩」,而是「让程序在正确的位置以正确的方式失败」。不要为了视觉上的健壮,到处加 fallback、catch-all 或默认值,把真实 bug 悄悄抹掉。

**不**应该兜底的情况:

- **协议 / 契约违反**:对端发了不该发的数据,这是 bug,不是边界条件。返回明确错误或直接 panic,不要用「合理」默认值继续往下走。
- **不变量被破坏**:理论上不可能进入的分支,用 `unreachable!()` / `panic!`,debug 构建用 `debug_assert!`,让问题在最近的现场暴露。
- **配置 / 启动期错误**:必需配置缺失、必需文件读不到,直接退出并打印诊断,不要带病运行。
- **测试无法触发的「保险」逻辑**:如果你写不出能命中这条 fallback 的测试,它通常不该存在。

**应该**容错的情况:

- 真实的运行时边界:网络抖动、用户输入、外部进程退出、磁盘满、PTY 关闭。
- 协议 / 类型层已明确允许的 optional 字段。
- 跨版本兼容的明确条款。

写 fallback 之前先问:**这个 fallback 是在掩盖一个真实的 bug 吗?** 不确定就先让错误冒出来,等定位到根因再决定怎么处理。早暴露的 bug 比埋在 fallback 里的 bug 便宜一个数量级。

## 死代码

不要保留真实死代码。

- 如果代码没有当前用途,也没有具体近期用途,删除。
- `#[allow(dead_code)]` 只允许用于当前实现必需但暂未直接调用的项目,或明确预留给已记录的近期功能。
- 每个 `#[allow(dead_code)]` 旁边必须有注释说明为什么暂时未使用仍然需要存在。
- 能通过单元测试覆盖 helper 的,不要用 `#[allow(dead_code)]` 压掉。
- `src/` 里的生产代码不允许留下无解释的 dead code allowance。

## Bug 修复流程

按以下顺序进行,**不做猜测式修复**:

1. **先静态阅读相关代码**。定位最可能的失败点,不先动生产代码。
2. **把怀疑变成测试**。写单元测试、集成测试或其他自动化测试来确认或否定假设。
3. **先证明假设**。新测试必须先失败,证明怀疑的原因真实存在。
4. **再实现修复**。用最小、连贯的生产代码改动解决已被测试证明的问题。
5. **验证修复**。新测试通过,相关既有测试也必须继续通过。

## 线程间通信

优先级:

1. **Channel**。默认选择。所有权转移清晰,避免共享可变状态。
2. **Lock-free**(例如 `AtomicU64`、`Arc<AtomicBool>`)。仅在 channel 开销被测量证明不可接受时使用。
3. **Mutex / RwLock**。最后选择,用于无法轻易重构的复杂共享状态。

Channel 选型:

- Worker 和其他同步线程默认使用 `crossbeam-channel`。`Sender` 可 clone,适合多个生产者把命令统一发送给单个长期线程。
- 控制面 async task 之间通信使用 `tokio::sync::mpsc`,避免在 Tokio runtime 中阻塞线程。
- 不把 `std::sync::mpsc` 作为新代码默认选择。只有在非常局部、无 clone / `select!` / bounded queue 需求的测试或临时代码中才允许使用。
- 优先用一个统一命令枚举承载线程间消息(例如 `GatewayCommand`)。只有当优先级、背压或生命周期确实不同,才拆多个 channel。

Lock-free 结构必须有注释块说明正确性:

- 使用了什么 ordering。
- 为什么这些 ordering 足够。
- 维护的不变量是什么。

```rust
// ORDERING: writer 在更新缓存快照后用 Release 顺序写入。
// Reader 在读取快照 generation 前用 Acquire 顺序读取。
// 这保证 reader 不会观察到「新 generation + 旧数据」的组合。
self.generation.store(next, Ordering::Release);
```

**无法解释 ordering 正确性的代码,不允许使用 lock-free。改用 channel。**

## unsafe

默认不写 `unsafe`。

每个 `unsafe` block 上方必须有 `// SAFETY:` 注释,说明为什么不变量成立。unsafe 作用域必须尽量小,优先封装进安全函数。

```rust
/// 把已验证的字节缓冲转成协议 frame。
///
/// 调用方永远不直接接触 unsafe,由这个函数负责维护不变量。
fn frame_from_bytes(bytes: &[u8]) -> Result<Frame, FrameError> {
    // SAFETY: 仅示例。生产代码优先使用安全 parser。
    unsafe { parse_frame_unchecked(bytes) }
}
```

如果 crate 提供安全 API,优先使用安全 API。不得为了「性能」绕过安全抽象,除非有 profiling 证明且经过 review。

## FFI

FFI 边界必须隔离在专门模块中,对外暴露安全 Rust 接口。调用方不得直接接触原始 FFI。

## 格式化与静态检查

- 提交前必须跑过 `cargo fmt`,CI 用 `cargo fmt --check` 作为 gate。
- `cargo clippy --all-targets -- -D warnings` 作为 CI gate,任何 warning 视同 error。
- 项目级 deny lint(写在 workspace `Cargo.toml` 的 `[lints.clippy]` 或 crate root):
  - `clippy::unwrap_used`
  - `clippy::dbg_macro`
  - `clippy::todo`
- 局部 `#[allow(...)]` 必须紧邻一条注释说明豁免理由,规则同「死代码」节。
