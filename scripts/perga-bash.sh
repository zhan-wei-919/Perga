# Perga shell integration — OSC 133 语义提示符标记(bash)。
#
# Perga 后端 spawn shell 时会自动注入本脚本(bash --rcfile),用户无需手动
# 配置。本脚本也可手动 `source`(用在非 Perga 终端,或自动注入失败时回退)。
# 未加载时 Perga 退化到纯 grid 模式,终端一切照常,只是没有命令块。
#
# OSC 133(FinalTerm / iTerm2 shell-integration 约定):
#   ESC ] 133 ; A ST            prompt 开始
#   ESC ] 133 ; B ST            prompt 结束 / 命令输入开始
#   ESC ] 133 ; C ST            命令开始执行
#   ESC ] 133 ; D ; <exit> ST   命令结束 + 退出码

# 只在交互式 bash 生效;非交互(脚本)直接退出。
case "$-" in
  *i*) ;;
  *) return 2>/dev/null || exit ;;
esac

# 防重复 source。
[ -n "${__PERGA_OSC133_LOADED:-}" ] && return
__PERGA_OSC133_LOADED=1

# C(命令开始执行)走 PS0 —— bash 4.4+ 在「命令读入后、执行前」展开一次 PS0。
#
# **不用 DEBUG trap**:DEBUG 在 PROMPT_COMMAND 的每条命令、PS1 的命令替换里
# 都会触发,要可靠地只在「用户命令」前发一次 C 极其难做对(starship / direnv
# 这类已有 PROMPT_COMMAND 会让 trap 提前命中、真命令反而漏掉)。PS0 是 bash
# 专为「命令执行前」设的独立钩子,与 PROMPT_COMMAND / PS1 完全无关,干净。
#
# bash < 4.4 没有 PS0 → C 不发,命令块整体不出现(干净降级)。
PS0='\033]133;C\033\\'"${PS0:-}"

# D(命令结束 + 退出码)走 PROMPT_COMMAND。prepend `__perga_precmd` 让 $? 先于
# 其它钩子被读到。bash 5.1+ 的 PROMPT_COMMAND 可以是数组 —— 保形 prepend,
# 当字符串拼会把用户的数组配置毁掉(只剩首项)。
#
# `__perga_precmd` 是 prepend 的,后面还跟着用户的 hook(starship / direnv 等)。
# 它必须 `return` 命令的真实退出码:否则函数返回值是 printf 的状态(恒 0),
# 后续 hook 看到的 $? 全变 0,失败命令会被显示成成功。
__perga_precmd() {
  local __perga_exit=$?
  printf '\033]133;D;%s\033\\' "$__perga_exit"
  return "$__perga_exit"
}
case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
  "declare -a"*)
    PROMPT_COMMAND=(__perga_precmd "${PROMPT_COMMAND[@]}")
    ;;
  *)
    PROMPT_COMMAND="__perga_precmd${PROMPT_COMMAND:+;}${PROMPT_COMMAND:-}"
    ;;
esac

# A 包在 PS1 最前、B 包在最后。\[ \] 把这些零宽字节标记给 readline,
# 否则行编辑会把 OSC 字节算进列宽,光标定位出错。
PS1='\[\033]133;A\033\\\]'"${PS1}"'\[\033]133;B\033\\\]'
