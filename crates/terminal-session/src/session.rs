//! [`TerminalSession`] 公共 handle + [`SessionInput`] 命令枚举。
//!
//! `TerminalSession` 拥有任意 [`Transport`] 实例(本地 PTY 或 SSH)和引擎线程
//! 的 join handle,在 Drop 时走严格顺序的清理:先 drop 输入 sender 让引擎线程
//! 跳出 select,再 drop transport(实现方的 Drop 杀子进程 / 关 SSH channel),
//! 最后 join 引擎线程。

use std::panic::AssertUnwindSafe;
use std::thread::{self, JoinHandle};

use crossbeam_channel::{Receiver, Sender};
use pty::{PtyConfig, PtySession};
use terminal_engine::TerminalEngine;
use terminal_input::{KeyEvent, MouseEvent};
use terminal_protocol::{ProtocolEncoder, ProtocolEvent};
use transport::{TerminalSize, Transport};

use crate::error::SessionError;
use crate::event_loop::run_engine_loop;

/// 引擎线程从外界收到的命令。Resize 既改 engine grid 也下发 transport SIGWINCH /
/// SSH `window_change`。
#[derive(Debug, Clone)]
pub enum SessionInput {
    Key(KeyEvent),
    Paste(String),
    Mouse(MouseEvent),
    /// `true` = focus gained,`false` = focus lost。
    Focus(bool),
    Resize(TerminalSize),
}

/// 一次终端会话的公共 handle。Drop 会同步等所有内部线程退出 + 杀子进程 /
/// 关 SSH channel(由具体 [`Transport`] 实现负责)。
pub struct TerminalSession {
    /// 任意 backend:本地 PTY 或 SSH。Drop 顺序由 [`Drop`] impl 手动控,字段
    /// 声明顺序只反映所有权,不依赖默认 drop 序。
    transport: Option<Box<dyn Transport>>,
    input_tx: Option<Sender<SessionInput>>,
    event_rx: Receiver<ProtocolEvent>,
    engine_thread: Option<JoinHandle<()>>,
}

impl TerminalSession {
    /// 起本地 PTY backend 并组装会话(Phase 0 ~ 4R 的唯一路径)。
    pub fn spawn_local(config: PtyConfig) -> Result<Self, SessionError> {
        let size = config.size;
        let pty = PtySession::spawn(config)
            .map_err(|e| SessionError::Spawn(format!("local pty: {e}")))?;
        Self::spawn_with_transport(Box::new(pty), size)
    }

    /// 用任意已构造好的 [`Transport`] 实现起一个会话。SSH backend 在
    /// `perga-server` / `crates/ssh` 那一层调这个入口;本地 PTY 走
    /// [`Self::spawn_local`] 的薄封装。
    ///
    /// `size` 必须和 transport 内部已经 negotiate 好的窗口尺寸一致 —— engine
    /// 用这个值构造初始 grid,baseline Init 也是按这个尺寸编码的。
    pub fn spawn_with_transport(
        transport: Box<dyn Transport>,
        size: TerminalSize,
    ) -> Result<Self, SessionError> {
        let mut engine = TerminalEngine::new(size);
        let mut encoder = ProtocolEncoder::new();

        let (input_tx, input_rx) = crossbeam_channel::unbounded::<SessionInput>();
        let (event_tx, event_rx) = crossbeam_channel::unbounded::<ProtocolEvent>();

        // Synthetic baseline:空 grid 的 Init。encoder 会缓存它,后续真实
        // Output 走 Patch。size 立刻可用,消费者不用等 backend 第一字节。
        let baseline = encoder.encode_frame(
            engine.snapshot(),
            engine.modes(),
            engine.title(),
            &[],
            false,
        );
        // event channel 是刚建的、capacity unbounded,这里 send 不可能失败。
        let _ = event_tx.send(baseline);

        let transport_event_rx = transport.event_rx().clone();
        let transport_command_tx = transport.command_tx().clone();

        let engine_thread = thread::Builder::new()
            .name("perga-engine".into())
            .spawn(move || {
                // catch_unwind 不是为了恢复 ── 是为了让 event_tx 在 panic 时
                // 自然 drop,消费者的 recv() 立刻拿到 Disconnected 而不是 hang。
                let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    run_engine_loop(
                        &mut engine,
                        &mut encoder,
                        &transport_event_rx,
                        &transport_command_tx,
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
            transport: Some(transport),
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

        // 2. drop transport ── PtySession::Drop 走 SIGHUP→500ms→SIGKILL,join 3
        //    个内部线程;SshSession::Drop 关 channel + disconnect + shutdown
        //    runtime。引擎线程持有的 transport event_rx clone 在 transport drop
        //    后会断开,即使 input_rx 没断,引擎线程也会从 TransportEvent 那一支
        //    收到 Disconnected 退出。
        self.transport.take();

        // 3. join 引擎线程。panic 已经在 catch_unwind 里被吞了,join 不应返回 Err;
        //    保险起见若真返回 Err 只记 log,不再 rethrow。
        if let Some(handle) = self.engine_thread.take() {
            if let Err(panic) = handle.join() {
                tracing::error!(?panic, "engine thread join returned panic");
            }
        }
    }
}
