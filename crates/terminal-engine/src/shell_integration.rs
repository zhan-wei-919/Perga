//! OSC 133 shell-integration 旁路解析。
//!
//! alacritty 0.25 不认 OSC 133,会静默丢弃。本模块用一个**旁路 `vte::Parser`**
//! 与主引擎吃同一份字节,只抽 OSC 133 的语义提示符标记(prompt / command
//! 边界),不影响主引擎的 grid 渲染。
//!
//! 标记本身只携带「在字节流的哪个位置」;它对应的**视口行**由 [`TerminalEngine`]
//! 在喂字节时按 OSC 边界采样光标得到(见 `engine.rs` 的 `feed`)。本模块只负责:
//! 1. 找出 OSC 133 在 chunk 里的字节偏移(`scan_segment`);
//! 2. 把带绝对行号的标记喂进一个状态机,凑齐 `command_start`→`command_end`
//!    就产出一个 [`CommandRegion`](`resolve_pending`)。
//!
//! 绝对行号「为什么」要由调用方给:alacritty 的光标行是视口相对坐标,滚动即
//! 失效;调用方维护一个单调 `scroll_total`,`scroll_total + 视口行` 才是稳定的
//! 绝对行号。本模块不碰 alacritty,只接收算好的值。

use std::collections::VecDeque;

/// 旁路解析器抽出的一个原始 OSC 133 标记。
///
/// 不含 `B`(prompt-end):它不携带 command-block 需要的任何坐标,A 给命令头
/// 起点、C 给命令起点、D 收尾,B 是冗余的,直接忽略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawMark {
    /// `OSC 133 ; A` —— 提示符开始,命令头的起点。
    PromptStart,
    /// `OSC 133 ; C` —— 命令开始执行,输出的起点。
    CommandStart,
    /// `OSC 133 ; D ; <exit>` —— 命令结束。
    CommandEnd { exit: Option<i32> },
}

/// 旁路解析器在字节流里识别出的一样东西:OSC 133 标记,或 alt-screen 进入。
enum RawScan {
    Mark(RawMark),
    /// `CSI ? <1049|1047|47> h` —— 进入 alt-screen。
    AltScreenEnter,
}

/// `scan_segment` 报告的一个切点 —— `feed` 必须在这里停下来推进 alacritty。
///
/// `is_mark` 为 true 时对应 `pending` 队首一个 OSC 133 标记,要 resolve/skip;
/// 为 false 是 alt-screen 进入序列,**只作切点** —— 让 `feed` 在这一点采到
/// alt-screen 状态转换(否则「同 chunk 内进出 alt-screen」会被整段跳过)。
pub(crate) struct ScanPoint {
    pub(crate) offset: usize,
    pub(crate) is_mark: bool,
}

/// 一条跑完的命令在终端 grid 里占据的绝对行区间。
///
/// 行号是 `scroll_total + 视口行` 的绝对坐标,跨滚动稳定。`TerminalEngine`
/// 在 `drain_marks` 时把它翻回当前 grid 坐标并取出 cell 内容。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CommandRegion {
    /// 命令头起点 `(绝对行, 列)`;`None` 表示没收到 `A`。列 >0 出现在上一条
    /// 命令输出无结尾换行、`A` 落在残留内容后面的情况。
    pub(crate) prompt: Option<(u64, u16)>,
    /// 命令输出起始绝对行(= `C` 时的光标行,列恒 0)。
    pub(crate) command_abs: u64,
    /// 命令输出结束绝对行(= `D` 时的光标行)。
    pub(crate) end_abs: u64,
    /// `D` 时的光标列。>0 说明命令输出无结尾换行,`end_abs` 行上有内容。
    pub(crate) end_col: u16,
    /// 退出码;shell 没带或解析失败时 `None`。
    pub(crate) exit: Option<i32>,
}

/// 标记状态机:把零散的 A/C/D 标记凑成完整的命令区间。
enum MarkState {
    /// 不在任何命令里。
    Idle,
    /// 见过 `A`,等 `C`。`prompt` = `(绝对行, 列)`。
    PromptSeen { prompt: (u64, u16) },
    /// 命令执行中,等 `D`。
    Executing {
        prompt: Option<(u64, u16)>,
        command_abs: u64,
    },
}

/// 旁路 OSC 133 解析 + 命令区间状态机。
///
/// 作为 [`TerminalEngine`] 的持久字段存在 —— 一条 OSC 序列可能跨多个 PTY
/// chunk,`vte::Parser` 的字节级状态必须连续,绝不能每 chunk 重建。
pub(crate) struct ShellIntegration {
    parser: vte::Parser,
    perform: SidePerform,
    /// `scan_segment` 已发现、尚未配上绝对行号的标记,FIFO。
    pending: VecDeque<RawMark>,
    state: MarkState,
    /// 已凑齐、等 `drain_regions` 取走的命令区间。
    resolved: Vec<CommandRegion>,
}

impl ShellIntegration {
    pub(crate) fn new() -> Self {
        Self {
            parser: vte::Parser::new(),
            perform: SidePerform::default(),
            pending: VecDeque::new(),
            state: MarkState::Idle,
            resolved: Vec::new(),
        }
    }

    /// 把一段字节逐字节喂给旁路解析器,返回每个切点(OSC 133 标记 / alt-screen
    /// 进入)在**序列终止之后一字节**的偏移(相对本次 `bytes`)。
    ///
    /// 逐字节是为了拿到精确偏移:调用方据此把同一段字节切片喂给 alacritty,在每个
    /// 切点处采样光标 / alt-screen 状态。标记按序进 `pending`,由后续等量次数的
    /// `resolve_pending` / `skip_pending` 配对消费。
    pub(crate) fn scan_segment(&mut self, bytes: &[u8]) -> Vec<ScanPoint> {
        debug_assert!(
            self.pending.is_empty(),
            "scan_segment 在上一批标记还没 resolve/skip 时被调用"
        );
        let mut points = Vec::new();
        for (i, &b) in bytes.iter().enumerate() {
            self.parser.advance(&mut self.perform, &[b]);
            for scan in self.perform.events.drain(..) {
                let is_mark = match scan {
                    RawScan::Mark(mark) => {
                        self.pending.push_back(mark);
                        true
                    }
                    RawScan::AltScreenEnter => false,
                };
                points.push(ScanPoint {
                    offset: i + 1,
                    is_mark,
                });
            }
        }
        points
    }

    /// 给 `pending` 队首的标记配上它的绝对行号 + 列,推进状态机。
    ///
    /// 调用次数必须与上一次 `scan_segment` 返回的偏移数一致。
    pub(crate) fn resolve_pending(&mut self, abs: u64, col: u16) {
        let Some(mark) = self.pending.pop_front() else {
            debug_assert!(false, "resolve_pending 没有待配对的标记");
            return;
        };
        match mark {
            RawMark::PromptStart => {
                // A 可以在任何状态出现(上一条命令异常没收尾也无妨),直接重置。
                self.state = MarkState::PromptSeen { prompt: (abs, col) };
            }
            RawMark::CommandStart => {
                let prompt = match self.state {
                    MarkState::PromptSeen { prompt } => Some(prompt),
                    // C 没有前导 A:命令头区间留空,仍可成块。
                    MarkState::Idle => None,
                    // C 紧接 C:上一条命令没收到 D,丢弃它。
                    MarkState::Executing { .. } => {
                        tracing::debug!("shell_integration.command_start_without_end");
                        None
                    }
                };
                self.state = MarkState::Executing {
                    prompt,
                    command_abs: abs,
                };
            }
            RawMark::CommandEnd { exit } => match self.state {
                MarkState::Executing {
                    prompt,
                    command_abs,
                } => {
                    self.resolved.push(CommandRegion {
                        prompt,
                        command_abs,
                        end_abs: abs,
                        end_col: col,
                        exit,
                    });
                    self.state = MarkState::Idle;
                }
                // D 没有前导 C(例如 source 集成脚本后的第一个 D):无命令可收。
                _ => tracing::debug!("shell_integration.command_end_without_start"),
            },
        }
    }

    /// 丢弃 `pending` 队首的一个标记 —— alt-screen 下用:旁路解析器仍要吃
    /// 字节保持对齐,但 TUI 里的 133 没有命令块语义,不喂状态机。
    pub(crate) fn skip_pending(&mut self) {
        let popped = self.pending.pop_front();
        debug_assert!(popped.is_some(), "skip_pending 没有待丢弃的标记");
    }

    /// 取走已凑齐的命令区间。
    pub(crate) fn drain_regions(&mut self) -> Vec<CommandRegion> {
        std::mem::take(&mut self.resolved)
    }

    /// 丢弃在途的命令状态与已凑齐但没取走的区间。resize / alt-screen 切换 /
    /// scrollback 被清时调用 —— 那些事件让绝对行号失真,旧数据不能用。
    ///
    /// **不**碰 `pending`:它是 `scan_segment`↔`resolve_pending` 的逐 mark 配对
    /// 队列,由 `feed` 循环严格一进一出;reset 可能在 feed 中途被调用,清它会
    /// 让循环错位。也**不**重置 `vte::Parser`:字节流连续,不打断。
    pub(crate) fn reset(&mut self) {
        self.state = MarkState::Idle;
        self.resolved.clear();
    }
}

/// 旁路 `vte::Parser` 的 `Perform`:抽 OSC 133 标记 + alt-screen 进入序列,
/// 其余序列全走默认空实现。
#[derive(Default)]
struct SidePerform {
    /// 本次 `advance` 新识别出的东西;`scan_segment` 每字节后立即 drain。
    events: Vec<RawScan>,
}

impl vte::Perform for SidePerform {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        // OSC 133 ; <kind> [; <arg>]。非 133 一律忽略 —— alacritty 也静默丢 133,
        // 两个解析器互不干扰,所以不需要 strip 原字节。
        if params.first().copied() != Some(b"133".as_slice()) {
            return;
        }
        let Some(kind) = params.get(1).and_then(|k| k.first()).copied() else {
            return;
        };
        let mark = match kind {
            b'A' => RawMark::PromptStart,
            b'C' => RawMark::CommandStart,
            b'D' => {
                let exit = params
                    .get(2)
                    .and_then(|p| std::str::from_utf8(p).ok())
                    .and_then(|s| s.parse::<i32>().ok());
                RawMark::CommandEnd { exit }
            }
            // 含 B(prompt-end):无用坐标,忽略。
            _ => return,
        };
        self.events.push(RawScan::Mark(mark));
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        // alt-screen 进入:`CSI ? <1049|1047|47> h`(`?` 被 vte 收进
        // intermediates)。只认进入 —— 退出无需切点,其后的 mark 自然采到
        // normal 态。识别它是为了让 feed 在「同 chunk 进出 alt-screen」时
        // 也能采到 mode 转换,不漏判穿过 alt-screen 的命令。
        if action != 'h' || !matches!(intermediates, [b'?']) {
            return;
        }
        let first = params.iter().next().and_then(|p| p.first().copied());
        if matches!(first, Some(1049 | 1047 | 47)) {
            self.events.push(RawScan::AltScreenEnter);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把一批 `(bytes, abs)` 喂进去:每段 `scan_segment` 后,按返回的偏移数
    /// 用对应的 `abs` 逐个 `resolve_pending`。偏移数必须等于 `abs` 个数。
    fn feed(shell: &mut ShellIntegration, segments: &[(&[u8], &[u64])]) {
        for (bytes, abs_list) in segments {
            let offsets = shell.scan_segment(bytes);
            assert_eq!(offsets.len(), abs_list.len(), "偏移数与提供的 abs 数不一致");
            for &abs in *abs_list {
                shell.resolve_pending(abs, 0);
            }
        }
    }

    fn osc(body: &str) -> Vec<u8> {
        format!("\x1b]{body}\x1b\\").into_bytes()
    }

    #[test]
    fn clean_a_c_d_yields_one_region() {
        let mut shell = ShellIntegration::new();
        let bytes: Vec<u8> = [osc("133;A"), osc("133;C"), osc("133;D;0")].concat();
        feed(&mut shell, &[(&bytes, &[10, 12, 15])]);
        assert_eq!(
            shell.drain_regions(),
            vec![CommandRegion {
                prompt: Some((10, 0)),
                command_abs: 12,
                end_abs: 15,
                end_col: 0,
                exit: Some(0),
            }]
        );
    }

    #[test]
    fn osc_split_across_two_scan_calls() {
        let mut shell = ShellIntegration::new();
        // 把 OSC 133;A 从中间切开,分两次 scan_segment 喂。
        assert!(shell.scan_segment(b"\x1b]133").is_empty());
        // 第二段 `;A\x1b\\` 4 字节;vte 在 ST 的 ESC(index 2)处 dispatch,
        // 偏移 = 3。ST 的 `\` 落到下一段,alacritty 那边照常续上。
        let points = shell.scan_segment(b";A\x1b\\");
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].offset, 3);
        assert!(points[0].is_mark);
        shell.resolve_pending(7, 0);
        // 接着 C / D,凑齐一条命令。
        feed(
            &mut shell,
            &[(&[osc("133;C"), osc("133;D;0")].concat(), &[8, 9])],
        );
        let regions = shell.drain_regions();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].prompt, Some((7, 0)));
    }

    #[test]
    fn command_end_without_start_is_dropped() {
        let mut shell = ShellIntegration::new();
        feed(&mut shell, &[(&osc("133;D;0"), &[5])]);
        assert!(shell.drain_regions().is_empty());
    }

    #[test]
    fn command_start_without_prompt_has_no_header() {
        let mut shell = ShellIntegration::new();
        let bytes: Vec<u8> = [osc("133;C"), osc("133;D;0")].concat();
        feed(&mut shell, &[(&bytes, &[3, 6])]);
        let regions = shell.drain_regions();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].prompt, None);
        assert_eq!(regions[0].command_abs, 3);
    }

    #[test]
    fn double_prompt_start_keeps_latest() {
        let mut shell = ShellIntegration::new();
        let bytes: Vec<u8> = [osc("133;A"), osc("133;A"), osc("133;C"), osc("133;D;0")].concat();
        feed(&mut shell, &[(&bytes, &[10, 20, 22, 25])]);
        let regions = shell.drain_regions();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].prompt, Some((20, 0)));
    }

    #[test]
    fn command_start_twice_drops_first() {
        let mut shell = ShellIntegration::new();
        let bytes: Vec<u8> = [osc("133;A"), osc("133;C"), osc("133;C"), osc("133;D;0")].concat();
        feed(&mut shell, &[(&bytes, &[10, 12, 30, 35])]);
        let regions = shell.drain_regions();
        assert_eq!(regions.len(), 1);
        // 第二个 C 丢了前一条在途命令,prompt 因此变 None。
        assert_eq!(regions[0].command_abs, 30);
        assert_eq!(regions[0].prompt, None);
    }

    #[test]
    fn multiple_commands_in_one_segment() {
        let mut shell = ShellIntegration::new();
        let bytes: Vec<u8> = [
            osc("133;A"),
            osc("133;C"),
            osc("133;D;0"),
            osc("133;A"),
            osc("133;C"),
            osc("133;D;1"),
        ]
        .concat();
        feed(&mut shell, &[(&bytes, &[1, 2, 3, 4, 5, 6])]);
        let regions = shell.drain_regions();
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].exit, Some(0));
        assert_eq!(regions[1].exit, Some(1));
        assert_eq!(regions[1].prompt, Some((4, 0)));
    }

    #[test]
    fn exit_code_variants() {
        let cases: &[(&str, Option<i32>)] = &[
            ("133;D;0", Some(0)),
            ("133;D;1", Some(1)),
            ("133;D;130", Some(130)),
            ("133;D", None),
            ("133;D;", None),
        ];
        for (body, want) in cases {
            let mut shell = ShellIntegration::new();
            let bytes: Vec<u8> = [osc("133;C"), osc(body)].concat();
            feed(&mut shell, &[(&bytes, &[1, 2])]);
            let regions = shell.drain_regions();
            assert_eq!(regions.len(), 1, "body={body}");
            assert_eq!(regions[0].exit, *want, "body={body}");
        }
    }

    #[test]
    fn command_end_records_cursor_column() {
        // D 的列被记进 end_col —— 命令输出无结尾换行时,引擎据此把 D 行补回。
        let mut shell = ShellIntegration::new();
        let offsets = shell.scan_segment(&[osc("133;C"), osc("133;D;0")].concat());
        assert_eq!(offsets.len(), 2);
        shell.resolve_pending(5, 0); // C,列恒 0
        shell.resolve_pending(5, 7); // D 落在同一行第 7 列
        let regions = shell.drain_regions();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].end_abs, 5);
        assert_eq!(regions[0].end_col, 7);
    }

    #[test]
    fn skip_pending_drops_one_mark() {
        let mut shell = ShellIntegration::new();
        let offsets = shell.scan_segment(&osc("133;C"));
        assert_eq!(offsets.len(), 1);
        shell.skip_pending();
        // pending 清空后 scan_segment 的 debug_assert 不会触发。
        let bytes: Vec<u8> = [osc("133;A"), osc("133;C"), osc("133;D;0")].concat();
        feed(&mut shell, &[(&bytes, &[10, 12, 15])]);
        assert_eq!(shell.drain_regions().len(), 1);
    }

    #[test]
    fn reset_clears_inflight_state() {
        let mut shell = ShellIntegration::new();
        feed(
            &mut shell,
            &[(&[osc("133;A"), osc("133;C")].concat(), &[10, 12])],
        );
        shell.reset();
        // reset 后 D 找不到在途命令,丢弃。
        feed(&mut shell, &[(&osc("133;D;0"), &[15])]);
        assert!(shell.drain_regions().is_empty());
    }

    #[test]
    fn non_133_osc_ignored() {
        let mut shell = ShellIntegration::new();
        // OSC 0(设标题)不应产生任何切点。
        let points = shell.scan_segment(&osc("0;some title"));
        assert!(points.is_empty());
    }

    #[test]
    fn scan_reports_alt_screen_enter() {
        let mut shell = ShellIntegration::new();
        let points = shell.scan_segment(b"\x1b[?1049h");
        assert_eq!(points.len(), 1);
        assert!(!points[0].is_mark, "alt-screen 进入是切点,不是 mark");
    }

    #[test]
    fn scan_ignores_alt_screen_exit() {
        // 退出 alt-screen 不需要切点。
        let mut shell = ShellIntegration::new();
        assert!(shell.scan_segment(b"\x1b[?1049l").is_empty());
    }
}
