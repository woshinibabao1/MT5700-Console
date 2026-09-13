#!/bin/sh
# ============================================================================
# 看门狗「AT / 本机 Shell 命令分流」回归测试
# ----------------------------------------------------------------------------
# 覆盖 2026-09-13 实测暴露出的四类真实缺陷（全部会静默出错，必须挡住）：
#   ① AT 下发通道用错传输：wget/HTTP 打裸 TCP newline-JSON 端口，永远失败
#   ② `A && B || C` 写法在 A 失败时会把 B 再执行一遍（命令跑两次）
#   ③ `printf '%b'` 还原多行会顺带解释 \t \c \\，改坏合法 shell 命令
#   ④ while 循环读命令列表没占用独立 fd，列表里的命令读 stdin 会吃掉后续行
# 另外覆盖：AT/shell 判据要认全 AT 族（ATE0 / ATI / 裸 AT），不能只认 AT+ / AT^
#
# 用法：sh tests/watchdog-routing.test.sh
# 退出码 0 = 全部通过
# ============================================================================

set -u

# 定位仓库根（脚本自身所在目录的上一级）。
# 注意先归一化路径分隔符：Windows 下（node 的 spawnSync / cmd 调用）$0 可能是
# `D:\a\b\c.sh` 这种反斜杠形式，而 `case $0 in */*)` 只认正斜杠，
# 不处理就会把「目录」误判成当前目录，进而找不到被测脚本。
_self=$(printf '%s' "$0" | tr '\\' '/')
case "$_self" in
	*/*) _dir=${_self%/*} ;;
	*)   _dir=. ;;
esac
ROOT="$_dir/.."
# 允许用第一个参数指定被测脚本（用于「拿旧版本验证这组测试确实抓得住 bug」）
WD="${1:-$ROOT/root/usr/share/mt5700/watchdog.sh}"

if [ ! -f "$WD" ]; then
	echo "找不到被测试的脚本：$WD" >&2
	exit 2
fi

PASS=0
FAIL=0
TMPD="$ROOT/.workbuddy/tmp-wd-test.$$"
mkdir -p "$TMPD"
# 尽力清理：CI 上正常删，受限环境下删不掉也不影响结论
trap 'rm -rf "$TMPD" 2>/dev/null || true' EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [ $# -gt 1 ] && printf '       %s\n' "$2"; }

# 断言两值相等
eq() { # eq <说明> <实际> <期望>
	if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "实际=[$2] 期望=[$3]"; fi
}

# ---------------------------------------------------------------------------
# 载入被测脚本
# ---------------------------------------------------------------------------
# lib/functions.sh 在路由器上才有，这里补上桩函数。
# 只取「函数定义」部分：末尾的 case 分发会在 source 时真的执行（并调用 exit），
# 所以裁掉它——测试只针对函数。
# 同时去掉 `. /lib/functions.sh`：`.` 是 POSIX 特殊内建，找不到文件会让整个
# shell 立刻退出（非交互模式下是致命错误），必须摘掉。
config_load() { :; }
config_get() { :; }
config_get_bool() { :; }
logger() { :; }

_wd_funcs=$(sed -n '1,/^case "\$1" in$/p' "$WD" | sed '$d' | grep -v '^\. /lib/functions\.sh')
eval "$_wd_funcs"

W_LOG=''
CMD_GAP=0
log_msg() { :; }

echo "== 1. split_cmds：多行还原 =="

# 脚本顶部的 W_RESET_CMDS 是空串（真值由 load_cfg 从 UCI 读），默认值在 DEF_RESET_CMDS。
# 用 :- 兜底：拿旧版本脚本做对照时它没有这个常量，不能让 set -u 把整个测试打断。
W_RESET_CMDS="${DEF_RESET_CMDS:-}"
out=$(split_cmds 2>/dev/null)
eq "默认三条还原为三行" "$(printf '%s' "$out" | wc -l | tr -d ' ')" "2"
eq "第 1 行" "$(printf '%s' "$out" | sed -n 1p)" "ifdown MT5700M"
eq "第 2 行" "$(printf '%s' "$out" | sed -n 2p)" "sleep 2"
eq "第 3 行" "$(printf '%s' "$out" | sed -n 3p)" "ifup MT5700M"

# ③ 只翻译 \n，其它反斜杠必须原样保留
W_RESET_CMDS='printf "a\tb"\necho ok'
eq "不解释 \\t（printf %b 会改坏）" "$(split_cmds | sed -n 1p)" 'printf "a\tb"'
eq "第二行仍是第二行" "$(split_cmds | sed -n 2p)" "echo ok"

# 单行（无 \n）也要正常
W_RESET_CMDS='AT+CSQ'
eq "单行不产生多余行" "$(split_cmds | wc -l | tr -d ' ')" "0"
eq "单行内容" "$(split_cmds)" "AT+CSQ"

W_RESET_CMDS='ifdown MT5700M\nsleep 2\nifup MT5700M'

echo "== 2. is_at_cmd：AT 族要认全 =="
for c in AT ATI ATE0 ATZ "AT&F" "AT+CSQ" "AT+CFUN=1,1" "AT^HVSST=1,0" "at+cmgf=0" "At+Z"; do
	if is_at_cmd "$c"; then ok "AT 判据命中：$c"; else no "AT 判据漏判：$c"; fi
done
for c in "ifdown MT5700M" "sleep 2" "ifup MT5700M" "reboot" "ubus call x y" "/etc/init.d/network restart"; do
	if is_at_cmd "$c"; then no "shell 命令被误判成 AT：$c"; else ok "shell 判据正确：$c"; fi
done

echo "== 3. json_escape：构造合法单行 JSON =="
eq "普通命令不变" "$(json_escape 'AT+CSQ')" 'AT+CSQ'
eq "双引号转义" "$(json_escape 'AT^X="a"')" 'AT^X=\"a\"'
eq "反斜杠转义" "$(json_escape 'a\b')" 'a\\b'

echo "== 4. run_sh_cmd：超时包装与退出码 =="
run_sh_cmd 'exit 0'; eq "成功命令返回 0" "$?" "0"
run_sh_cmd 'exit 7'; eq "退出码透传" "$?" "7"
run_sh_cmd 'printf hello'; eq "stdout 被捕获" "${_shout:-}" "hello"

# ② 核心回归：失败的命令只允许执行一次
CNT="$TMPD/cnt"
printf '' > "$CNT"
run_sh_cmd "printf x >> $CNT; exit 1"
eq "失败命令的执行次数" "$(wc -c < "$CNT" | tr -d ' ')" "1"
run_sh_cmd "printf x >> $CNT; exit 0"
eq "成功命令的执行次数" "$(wc -c < "$CNT" | tr -d ' ')" "2"

echo "== 5. send_at：校验应答里的 success =="
rpc_send() { printf '%s\n' "$MOCK_RESP"; return "$MOCK_RC"; }

MOCK_RC=0
MOCK_RESP='{"id":1,"result":{"success":true,"data":"+CSQ: 20\r\nOK","error":null}}'
send_at 'AT+CSQ'; eq "success:true → 0" "$?" "0"

MOCK_RESP='{"id":1,"result":{"success":false,"data":null,"error":"模组无响应（已等待 2000ms）: AT+CSQ"}}'
send_at 'AT+CSQ'; eq "success:false → 1" "$?" "1"
case "${AT_LAST_ERR:-}" in
	*模组无响应*) ok "失败原因取自 error 字段" ;;
	*) no "失败原因未提取" "AT_LAST_ERR=[${AT_LAST_ERR:-}]" ;;
esac

MOCK_RESP='{"id":1,"error":{"code":-32001,"message":"认证失败"}}'
send_at 'AT+CSQ'; eq "认证失败 → 1" "$?" "1"
case "${AT_LAST_ERR:-}" in
	*认证失败*) ok "认证失败走 message 字段" ;;
	*) no "认证失败原因未提取" "AT_LAST_ERR=[${AT_LAST_ERR:-}]" ;;
esac

MOCK_RESP=''; MOCK_RC=1
send_at 'AT+CSQ'; eq "连不上后端 → 1" "$?" "1"

echo "== 6. reset_modem：AT/SH 混排按序执行 =="
RUNLOG="$TMPD/run.log"
: > "$RUNLOG"

# 用桩替换两个执行器，只记录「谁按什么顺序被执行」
send_at() { printf 'AT  %s\n' "$1" >> "$RUNLOG"; [ "$1" = "AT^FAIL" ] && return 1; return 0; }
run_sh_cmd() { printf 'SH  %s\n' "$1" >> "$RUNLOG"; [ "$1" = "false" ] && return 1; return 0; }

# 顺序：shell → 注释 → 空行 → AT → shell → 失败 AT → 失败 shell → 带反斜杠的 shell
# （注释行与空行会被跳过，所以真正执行的只有 6 条）
W_RESET_CMDS='ifdown MT5700M\n# 这是一行注释\n\nAT^HVSST=1,0\nsleep 2\nAT^FAIL\nfalse\nprintf "a\tb"'
reset_modem
rc=$?
eq "存在失败命令时 reset_modem 返回 1" "$rc" "1"

eq "注释与空行被忽略（共 6 条）" "$(wc -l < "$RUNLOG" | tr -d ' ')" "6"
eq "第 1 条是 shell" "$(sed -n 1p "$RUNLOG")" "SH  ifdown MT5700M"
eq "第 2 条是 AT" "$(sed -n 2p "$RUNLOG")" "AT  AT^HVSST=1,0"
eq "第 3 条是 shell" "$(sed -n 3p "$RUNLOG")" "SH  sleep 2"
eq "失败 AT 也在序内" "$(sed -n 4p "$RUNLOG")" "AT  AT^FAIL"
eq "失败 shell 也在序内" "$(sed -n 5p "$RUNLOG")" "SH  false"
eq "反斜杠命令原样送达" "$(sed -n 6p "$RUNLOG")" 'SH  printf "a\tb"'
eq "混排顺序完全保真" "$(sed -n 1,6p "$RUNLOG" | tr '\n' '|')" \
	'SH  ifdown MT5700M|AT  AT^HVSST=1,0|SH  sleep 2|AT  AT^FAIL|SH  false|SH  printf "a\tb"|'

# 全部成功时应返回 0
: > "$RUNLOG"
send_at() { printf 'AT  %s\n' "$1" >> "$RUNLOG"; return 0; }
run_sh_cmd() { printf 'SH  %s\n' "$1" >> "$RUNLOG"; return 0; }
W_RESET_CMDS='ifdown MT5700M\nsleep 2\nifup MT5700M'
reset_modem; eq "全部成功 → 0" "$?" "0"
eq "默认三条全被执行" "$(wc -l < "$RUNLOG" | tr -d ' ')" "3"

# ④ 核心回归：列表里的命令读 stdin 不能吃掉后续行
: > "$RUNLOG"
run_sh_cmd() {
	printf 'SH  %s\n' "$1" >> "$RUNLOG"
	# 模拟一个会读 stdin 的命令：没有独立 fd 时它会吞掉剩余命令
	cat >/dev/null 2>&1
	return 0
}
W_RESET_CMDS='first\nsecond\nthird'
reset_modem
eq "读 stdin 的命令不吃掉后续命令" "$(wc -l < "$RUNLOG" | tr -d ' ')" "3"
eq "第三条仍在" "$(sed -n 3p "$RUNLOG")" "SH  third"

echo
if [ "$FAIL" -eq 0 ]; then
	printf 'PASS 全部通过（%d 项）\n' "$PASS"
	exit 0
fi
printf 'FAILED %d 项失败 / 共 %d 项\n' "$FAIL" "$((PASS + FAIL))"
exit 1
