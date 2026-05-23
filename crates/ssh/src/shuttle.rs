//! shuttle loop:在 tokio current_thread runtime 上跑的数据穿梭主循环。
//!
//! 三个事件源 + 优雅退出:
//! 1. `command_rx`(tokio mpsc;由 bridge 线程从 crossbeam 转过来)
//!    → 翻成 russh `Channel::data_bytes` / `window_change` / `close`。
//! 2. `channel.wait()` → russh `ChannelMsg`,主要消费 `Data` / `ExitStatus` /
//!    `ExitSignal` / `Eof` / `Close`,翻成 [`TransportEvent::Output`] /
//!    [`TransportEvent::Exited`]。
//! 3. `shutdown_rx`(tokio oneshot)→ 上层主动要求关闭:close channel +
//!    disconnect session,退出循环。
//!
//! `TransportEvent::Exited` **保证最后一个事件**:观察到 `Eof` / `Close` /
//! 远端断开 / shutdown 信号之后**才** emit Exited 然后跳出。

use std::time::Duration;

use crossbeam_channel::Sender as XbSender;
use russh::client::Handle;
use russh::{Channel, ChannelMsg, Disconnect};
use tokio::sync::mpsc::UnboundedReceiver as TkReceiver;
use tokio::sync::oneshot;
use transport::{ExitStatus, TransportCommand, TransportError, TransportEvent};

use crate::handler::PergaHandler;

/// `channel.close()` / `handle.disconnect()` 的 budget。
/// 网络断了的情况下这些 await 可能不返回,加超时避免 shuttle 线程卡死。
const CLOSE_TIMEOUT: Duration = Duration::from_millis(500);

/// 主穿梭循环。返回时 shuttle 线程会让 runtime 退出。
pub(crate) async fn shuttle_loop(
    handle: Handle<PergaHandler>,
    mut channel: Channel<russh::client::Msg>,
    mut command_rx: TkReceiver<TransportCommand>,
    event_tx: XbSender<TransportEvent>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let mut pending_exit: Option<ExitStatus> = None;

    loop {
        tokio::select! {
            // 优先看 shutdown,避免上层要求关闭后还在拼命处理输入 / 等远端。
            biased;
            _ = &mut shutdown_rx => {
                // 上层(`SshSession::Drop`)主动要求关闭。优雅关闭 channel +
                // disconnect;超时就 break 不管,让 runtime drop 回收剩余。
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
                let _ = tokio::time::timeout(
                    CLOSE_TIMEOUT,
                    handle.disconnect(Disconnect::ByApplication, "perga shutdown", ""),
                ).await;
                // 不 emit Exited:用户主动关的会话,前端已通过别的路径感知
                // (engine thread 检测到 transport channel disconnect 后退出);
                // 多发一条会被当成「子进程退出」误处理。
                break;
            }

            // 上层来的命令(Write / Resize / Shutdown)。
            cmd = command_rx.recv() => {
                let Some(cmd) = cmd else {
                    // bridge 线程 / 外部 sender 全断了。视作 shutdown:
                    // close channel + disconnect,break。
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
                    break;
                };
                if !handle_command(&channel, cmd, &event_tx).await {
                    break;
                }
            }

            // 远端来的 channel 消息。
            msg = channel.wait() => {
                let Some(msg) = msg else {
                    // 远端关了 channel / 连接断开。pending_exit 有 = emit;
                    // 没有(对端直接断)= 用 None code/signal,前端按"异常关闭"处理。
                    let status = pending_exit.unwrap_or(ExitStatus {
                        code: None,
                        signal: None,
                    });
                    let _ = event_tx.send(TransportEvent::Exited(status));
                    break;
                };
                let action = handle_channel_msg(msg, &event_tx, &mut pending_exit);
                match action {
                    ChannelAction::Continue => {}
                    ChannelAction::Break => break,
                }
            }
        }
    }
}

/// 一条 `TransportCommand` 的处理结果:是否继续主循环。
async fn handle_command(
    channel: &Channel<russh::client::Msg>,
    cmd: TransportCommand,
    event_tx: &XbSender<TransportEvent>,
) -> bool {
    match cmd {
        TransportCommand::Write(bytes) => {
            // `data_bytes` 不 copy,直接把 Vec<u8> 当 Bytes 走 channel。
            if let Err(e) = channel.data_bytes(bytes).await {
                tracing::warn!(error = %e, "ssh.shuttle.write_failed");
                let _ = event_tx.send(TransportEvent::Error(TransportError::Write(format!(
                    "ssh channel write: {e}"
                ))));
                return false;
            }
            true
        }
        TransportCommand::Resize(size) => {
            // window_change 失败一般是 channel 已 close;归 warn,不致命。
            // engine 路径下一个 SIGWINCH-equivalent 还会重试。
            if let Err(e) = channel
                .window_change(size.cols as u32, size.rows as u32, 0, 0)
                .await
            {
                tracing::warn!(error = %e, "ssh.shuttle.resize_failed");
            }
            true
        }
        TransportCommand::Shutdown => {
            // 等价 shutdown_rx:close + 走出循环,让远端 channel/Conn 自然回收。
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
            false
        }
    }
}

enum ChannelAction {
    Continue,
    Break,
}

fn handle_channel_msg(
    msg: ChannelMsg,
    event_tx: &XbSender<TransportEvent>,
    pending_exit: &mut Option<ExitStatus>,
) -> ChannelAction {
    match msg {
        ChannelMsg::Data { data } => {
            if event_tx
                .send(TransportEvent::Output(data.to_vec()))
                .is_err()
            {
                // 消费者断了,后续输出也送不出去。
                return ChannelAction::Break;
            }
            ChannelAction::Continue
        }
        // stderr 走 ExtendedData(SSH 协议把它从 stdout 分开);PTY 模式下
        // 远端通常会合并到 Data,但严谨起见也走 Output 上传。
        ChannelMsg::ExtendedData { data, .. } => {
            if event_tx
                .send(TransportEvent::Output(data.to_vec()))
                .is_err()
            {
                return ChannelAction::Break;
            }
            ChannelAction::Continue
        }
        ChannelMsg::ExitStatus { exit_status } => {
            // 暂存,等 Eof/Close 才真正 emit ── ExitStatus 永远在 Eof 之前到达。
            // 中间还可能有缓冲的 Data。
            // i32::try_from 防御性,exit_status 实际是 u32,>= 2^31 的真实退出码
            // 几乎不存在。
            *pending_exit = Some(ExitStatus {
                code: i32::try_from(exit_status).ok(),
                signal: None,
            });
            ChannelAction::Continue
        }
        ChannelMsg::ExitSignal { signal_name, .. } => {
            // signal_name 是 russh `Sig` enum(OpenSSH 字符串名的强类型表示),
            // 不是 libc 数字。v1 把常见信号映射到数字,Custom / 其他归 None,
            // 让上层按"异常退出 / 信号未知"处理。
            *pending_exit = Some(ExitStatus {
                code: None,
                signal: sig_to_number(&signal_name),
            });
            ChannelAction::Continue
        }
        ChannelMsg::Eof | ChannelMsg::Close => {
            // 远端结束:emit Exited(用 pending_exit,没有就 None 默认),退循环。
            let status = pending_exit.take().unwrap_or(ExitStatus {
                code: None,
                signal: None,
            });
            let _ = event_tx.send(TransportEvent::Exited(status));
            ChannelAction::Break
        }
        // 其他 msg(WindowAdjusted、Success、Failure 等)对 transport 层不可见,
        // russh 自己已经处理。
        _ => ChannelAction::Continue,
    }
}

/// russh `Sig` enum → libc 信号数字。`Custom(_)` / 未知归 `None` —— 不强行
/// 猜测,让上层按"异常退出 / 信号未知"处理。
fn sig_to_number(sig: &russh::Sig) -> Option<i32> {
    use russh::Sig;
    Some(match sig {
        Sig::ABRT => 6,
        Sig::ALRM => 14,
        Sig::FPE => 8,
        Sig::HUP => 1,
        Sig::ILL => 4,
        Sig::INT => 2,
        Sig::KILL => 9,
        Sig::PIPE => 13,
        Sig::QUIT => 3,
        Sig::SEGV => 11,
        Sig::TERM => 15,
        Sig::USR1 => 10,
        Sig::Custom(_) => return None,
    })
}
