//! 引擎线程主循环 ── 在 `TransportEvent` 和 `SessionInput` 两个源之间 select,
//! 把 backend 字节翻成 `ProtocolEvent`,把上层命令翻成 backend 字节。
//!
//! 单线程独占 `TerminalEngine` 和 `ProtocolEncoder`,所有可变状态都在这里。
//! 外界通过 channel 进出,不持锁,不共享内部状态。
//!
//! Coalescing 故意不做:一个 `TransportEvent::Output` → 0~N 条 `CommandEnd`
//! + 一个 `encode_frame`。Encoder 内部 RLE + row diff 已经把 wire size 压住,
//!   真有性能问题再在这里加 batching。

use crossbeam_channel::{select, Receiver, Sender};
use terminal_engine::{Row, TerminalEngine};
use terminal_input::{encode_focus, encode_key, encode_mouse, encode_paste};
use terminal_protocol::{ProtocolEncoder, ProtocolEvent};
use transport::{TransportCommand, TransportEvent};

use crate::session::SessionInput;

/// 引擎线程主循环。返回即线程结束。
///
/// 退出条件:任一上行 channel(input / transport event)disconnect,或 event_tx
/// 已无消费者(`send` 返回 Err)。
pub(crate) fn run_engine_loop(
    engine: &mut TerminalEngine,
    encoder: &mut ProtocolEncoder,
    transport_event_rx: &Receiver<TransportEvent>,
    transport_command_tx: &Sender<TransportCommand>,
    input_rx: &Receiver<SessionInput>,
    event_tx: &Sender<ProtocolEvent>,
) {
    loop {
        select! {
            recv(transport_event_rx) -> msg => {
                match msg {
                    Ok(ev) => {
                        if !handle_transport_event(engine, encoder, ev, transport_command_tx, event_tx) {
                            return;
                        }
                    }
                    // Backend 反方向先死了。引擎线程也跟着退,event_tx drop 后消费者
                    // recv() 拿到 Disconnected。
                    Err(_) => return,
                }
            }
            recv(input_rx) -> msg => {
                match msg {
                    Ok(input) => {
                        if !handle_session_input(engine, encoder, input, transport_command_tx, event_tx) {
                            return;
                        }
                    }
                    // 上层 TerminalSession 被 Drop,input_tx 没了。退出。
                    Err(_) => return,
                }
            }
        }
    }
}

/// 处理一个 TransportEvent。返回 `false` 表示「主循环应立即退出」(消费者断开 / 子进程已 Exited)。
fn handle_transport_event(
    engine: &mut TerminalEngine,
    encoder: &mut ProtocolEncoder,
    ev: TransportEvent,
    transport_command_tx: &Sender<TransportCommand>,
    event_tx: &Sender<ProtocolEvent>,
) -> bool {
    match ev {
        TransportEvent::Output(bytes) => {
            engine.feed(&bytes);
            // Engine 想回写的协议响应(CPR / DA 等)必须在 encode_frame 之前
            // 灌回 backend ── TUI 应用会等这些响应,慢一步就 hang。
            for w in engine.drain_pending_writes() {
                if transport_command_tx
                    .send(TransportCommand::Write(w))
                    .is_err()
                {
                    // backend 写端死了,后续输出也送不出去,直接退。
                    return false;
                }
            }
            // 跑完的命令 ── 在 emit_frame 之前发,前端在收到对应 Patch 之前
            // 先记下命令结束(失败的据此打标记;autotest 据此判定命令跑完)。
            for cmd in engine.drain_command_ends() {
                if event_tx
                    .send(encoder.encode_command_end(cmd.line, cmd.exit))
                    .is_err()
                {
                    return false;
                }
            }
            let cleared = engine.scrollback_cleared();
            let scrolled = engine.take_scrolled_rows();
            emit_frame(engine, encoder, event_tx, &scrolled, cleared)
        }
        TransportEvent::Exited(status) => {
            // TransportEvent::Exited 是 backend 层的最后一个事件契约,
            // 后续不会再有 Output,直接发 Exited 并退出。
            //
            // `status` 已经是 transport::ExitStatus(== terminal_protocol::ExitStatus
            // 同一类型),不需要再翻译一层。
            let _ = event_tx.send(encoder.encode_exited(status));
            false
        }
        TransportEvent::Error(err) => {
            // 致命错误,但发起方(reader/writer/waiter)已经在自己退出。这里
            // 只 log;后续 channel 会 disconnect 让循环自然退。
            tracing::error!(error = %err, "transport fatal error event");
            true
        }
    }
}

/// 处理一个 SessionInput。返回 `false` 表示「主循环应立即退出」(消费者断开)。
fn handle_session_input(
    engine: &mut TerminalEngine,
    encoder: &mut ProtocolEncoder,
    input: SessionInput,
    transport_command_tx: &Sender<TransportCommand>,
    event_tx: &Sender<ProtocolEvent>,
) -> bool {
    match input {
        SessionInput::Key(k) => {
            let bytes = encode_key(&k, &engine.modes());
            // 空 Vec 是 Encoder 对未映射键的稳定返回(不该走到 ── FunctionKey
            // 已经 type-level 拦截,但 Char + 未定义 Ctrl 组合理论上会到)。
            if !bytes.is_empty()
                && transport_command_tx
                    .send(TransportCommand::Write(bytes))
                    .is_err()
            {
                return false;
            }
            true
        }
        SessionInput::Paste(text) => {
            let bytes = encode_paste(&text, &engine.modes());
            if transport_command_tx
                .send(TransportCommand::Write(bytes))
                .is_err()
            {
                return false;
            }
            true
        }
        SessionInput::Mouse(m) => {
            // None = 当前 mode 不上报(Off / Drag 在 Normal 等)。
            if let Some(bytes) = encode_mouse(&m, &engine.modes()) {
                if transport_command_tx
                    .send(TransportCommand::Write(bytes))
                    .is_err()
                {
                    return false;
                }
            }
            true
        }
        SessionInput::Focus(gained) => {
            if let Some(bytes) = encode_focus(gained, &engine.modes()) {
                if transport_command_tx
                    .send(TransportCommand::Write(bytes))
                    .is_err()
                {
                    return false;
                }
            }
            true
        }
        SessionInput::Resize(size) => {
            engine.resize(size);
            if transport_command_tx
                .send(TransportCommand::Resize(size))
                .is_err()
            {
                return false;
            }
            // size 变了 encoder 会发 Init(包含新 size 的 baseline);size 没变
            // 则是一个空 Patch ── 都是合法的,消费者照样处理。resize 不滚动,
            // 故 scrolled 为空、cleared 为 false。
            emit_frame(engine, encoder, event_tx, &[], false)
        }
    }
}

/// 把当前 engine 状态 encode 一帧推到 event channel。`scrolled` 是本帧滚出
/// viewport 顶的行,`cleared` 标记 scrollback 被清。返回 `false` 表示 send 失败。
fn emit_frame(
    engine: &TerminalEngine,
    encoder: &mut ProtocolEncoder,
    event_tx: &Sender<ProtocolEvent>,
    scrolled: &[Row],
    cleared: bool,
) -> bool {
    let ev = encoder.encode_frame(
        engine.snapshot(),
        engine.modes(),
        engine.title(),
        scrolled,
        cleared,
    );
    event_tx.send(ev).is_ok()
}
