# Perga shell integration — OSC 133 语义提示符标记(zsh)。
#
# Perga 后端 spawn shell 时会自动注入本脚本(ZDOTDIR 重定向),用户无需手动
# 配置。本脚本也可手动 `source`(用在非 Perga 终端,或自动注入失败时回退)。
# 未加载时 Perga 退化到纯 grid 模式,终端一切照常,只是没有命令块。
#
# OSC 133(FinalTerm / iTerm2 shell-integration 约定):
#   ESC ] 133 ; A ST            prompt 开始
#   ESC ] 133 ; B ST            prompt 结束 / 命令输入开始
#   ESC ] 133 ; C ST            命令开始执行
#   ESC ] 133 ; D ; <exit> ST   命令结束 + 退出码

# 只在交互式 zsh 生效。
[[ -o interactive ]] || return

# 防重复 source。
(( ${+__PERGA_OSC133_LOADED} )) && return
__PERGA_OSC133_LOADED=1

__perga_emit() { printf '\033]133;%s\033\\' "$1" }

# precmd:每次画 prompt 前跑,发上一条命令的 D + 退出码。
# 必须第一个跑,否则 $? 会被别的 precmd 钩子污染 —— 故下面 prepend。
#
# `__perga_precmd` prepend 在用户 precmd hook 前面,必须 `return` 命令的真实
# 退出码:否则函数返回值是 __perga_emit(printf)的状态(恒 0),后续 precmd
# hook 看到的 $? 全变 0,失败命令会被显示成成功。
__perga_precmd() {
  local __perga_exit=$?
  __perga_emit "D;$__perga_exit"
  return $__perga_exit
}

# preexec:命令开始执行前跑。zsh 原生钩子,不需要 bash 那种 DEBUG-trap 去重。
__perga_preexec() { __perga_emit "C" }

precmd_functions=(__perga_precmd $precmd_functions)
preexec_functions+=(__perga_preexec)

# A 包在 PROMPT 最前、B 包在最后。%{ %} 告诉 zsh 这些字节零宽,
# 否则行编辑会把 OSC 字节算进列宽,光标定位出错。
PROMPT=$'%{\033]133;A\033\\%}'"${PROMPT}"$'%{\033]133;B\033\\%}'
