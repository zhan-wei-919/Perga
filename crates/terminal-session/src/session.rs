//! [`TerminalSession`] 公共 handle + [`SessionInput`] 命令枚举。
//!
//! `TerminalSession` 拥有 `PtySession` 和引擎线程的 join handle,在 Drop 时
//! 走严格顺序的清理:先 drop 输入 sender 让引擎线程跳出 select,再 drop
//! PTY 杀子进程 + join 内部线程,最后 join 引擎线程。

use std::panic::AssertUnwindSafe;
use std::thread::{self, JoinHandle};

use crossbeam_channel::{Receiver, Sender};
use pty::{PtyConfig, PtySession};
use terminal_engine::{TerminalEngine, TerminalSize};
use terminal_input::{KeyEvent, MouseEvent};
use terminal_protocol::{ProtocolEncoder, ProtocolEvent};

use crate::error::SessionError;
use crate::event_loop::run_engine_loop;

/// 引擎线程从外界收到的命令。Resize 既改 engine grid 也下发 PTY SIGWINCH。
#[derive(Debug, Clone)]
pub enum SessionInput {
    Key(KeyEvent),
    Paste(String),
    Mouse(MouseEvent),
    /// `true` = focus gained,`false` = focus lost。
    Focus(bool),
    Resize(TerminalSize),
}

/// 一次终端会话的公共 handle。Drop 会同步等所有内部线程退出 + 杀子进程。
pub struct TerminalSession {
    /// 顺序很重要:`engine_thread` 在 `pty` 之前 ── 引擎线程持有 `pty` 的
    /// channel clone,必须先让它跑完才 drop pty。Rust struct 字段按声明
    /// **倒序** drop,所以引擎 thread handle 写在 pty 后面。
    /// 但我们手动在 `Drop` impl 里控顺序,字段声明只反映所有权,不依赖
    /// 默认 drop 序。
    pty: Option<PtySession>,
    input_tx: Option<Sender<SessionInput>>,
    event_rx: Receiver<ProtocolEvent>,
    engine_thread: Option<JoinHandle<()>>,
}

impl TerminalSession {
    /// 起 PTY、推一个 synthetic baseline Init 到 event channel,再起引擎线程。
    ///
    /// Init 必须在引擎线程**启动之前**入队:否则消费者可能先看到一条由
    /// shell 真实输出触发的 Init,失去「连上就有 baseline」的契约。
    pub fn spawn(config: PtyConfig) -> Result<Self, SessionError> {
        let size = TerminalSize::new(config.size.rows, config.size.cols);

        // PTY 启动失败把 PtyError 的整条 source-chain 拍扁带走,避免泄漏底层类型。
        let pty = PtySession::spawn(config).map_err(|e| SessionError::Spawn(format!("{e}")))?;

        let mut engine = TerminalEngine::new(size);
        let mut encoder = ProtocolEncoder::new();

        let (input_tx, input_rx) = crossbeam_channel::unbounded::<SessionInput>();
        let (event_tx, event_rx) = crossbeam_channel::unbounded::<ProtocolEvent>();

        // Synthetic baseline:空 grid 的 Init。encoder 会缓存它,后续真实
        // Output 走 Patch。size 立刻可用,消费者不用等 shell 第一字节。
        let baseline = encoder.encode_frame(engine.snapshot(), engine.modes(), engine.title());
        // event channel 是刚建的、capacity unbounded,这里 send 不可能失败。
        let _ = event_tx.send(baseline);

        let pty_event_rx = pty.event_rx().clone();
        let pty_command_tx = pty.command_tx().clone();

        let engine_thread = thread::Builder::new()
            .name("perga-engine".into())
            .spawn(move || {
                // catch_unwind 不是为了恢复 ── 是为了让 event_tx 在 panic 时
                // 自然 drop,消费者的 recv() 立刻拿到 Disconnected 而不是 hang。
                let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    run_engine_loop(
                        &mut engine,
                        &mut encoder,
                        &pty_event_rx,
                        &pty_command_tx,
                        &input_rx,
                        &event_tx,
                    );
                }));
                if let Err(panic) = result {
                    tracing::error!(?panic, "engine thread panicked");
                }
            })
            .map_err(|e| SessionError::Spawn(format!("spawn engine thread: {e}")))?;

        Ok(Self {
            pty: Some(pty),
            input_tx: Some(input_tx),
            event_rx,
            engine_thread: Some(engine_thread),
        })
    }

    /// 上层往这送 Key / Paste / Mouse / Focus / Resize。`Sender` 是 Clone 的,
    /// 多生产者可以共享。
    pub fn input(&self) -> &Sender<SessionInput> {
        // input_tx 只在 Drop 里被 take(),其他时候永远 Some。
        self.input_tx.as_ref().expect("input_tx is Some until Drop")
    }

    /// 上层从这收 ProtocolEvent。`recv()` 返回 Err 表示引擎线程退出。
    pub fn events(&self) -> &Receiver<ProtocolEvent> {
        &self.event_rx
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        // 1. drop input_tx ── 引擎线程的 input_rx 收到 Disconnected,跳出 select。
        self.input_tx.take();

        // 2. drop pty ── PtySession::Drop 走 SIGHUP→500ms→SIGKILL,join 3 个内部线程。
        //    引擎线程持有的 pty_event_rx clone 在 pty drop 后会断开,即使 input_rx
        //    没断,引擎线程也会从 PtyEvent 那一支收到 Disconnected 退出。
        self.pty.take();

        // 3. join 引擎线程。panic 已经在 catch_unwind 里被吞了,join 不应返回 Err;
        //    保险起见若真返回 Err 只记 log,不再 rethrow。
        if let Some(handle) = self.engine_thread.take() {
            if let Err(panic) = handle.join() {
                tracing::error!(?panic, "engine thread join returned panic");
            }
        }
    }
}
