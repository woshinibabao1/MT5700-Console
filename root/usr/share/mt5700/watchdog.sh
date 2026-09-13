#!/bin/sh
# ============================================================================
# MT5700 连接看门狗
# ----------------------------------------------------------------------------
# 解决的实际故障（2026-09-13 实测发生两次）：
#   模组 USB 重新枚举后，cdc_ncm 会重新注册 eth2；netifd 只看到「link up」，
#   不会重跑 DHCP（接口 force_link=1，且租约长达 6 天），于是路由器继续持有
#   失效地址 → 默认网关的 ARP 永远 INCOMPLETE → 完全没网，而路由器本身看着正常。
#
# 判定与动作：
#   1) 接口未 up            → ubus renew（失败则 ifdown/ifup）
#   2) 探测目标不可达        → ubus renew 续约（失败则 ifdown/ifup）
#   3) 连续失败达阈值        → 按「复位命令」逐条执行（UCI watch_reset_cmds，可多行自定义）
#
# 「探测目标」由 UCI watch_gateway 决定（界面里可改）：
#   · 非空（**默认 119.29.29.29 = 腾讯 DNS / DNSPod**）→ 直接 ICMP 探测该地址。
#     这是最贴近「用户到底能不能上网」的判据，而且用的是**公网 IP**，
#     不依赖本地解析器 —— 本机有过 mosdns / OpenClash 劫持的历史，
#     拿域名做探测会被本地解析器误导，得出「能上网」的错误结论。
#   · 填 `none` → 回退为旧行为：自动取 watch_device 上的默认路由网关，查它的邻居(ARP)状态。
#     （用哨兵而不是留空，是因为 config_get 是 `:-` 语义，空值会落回默认值，区分不出来。）
#     目标多半是公网地址、不在二层邻居表里，所以「有目标」时不能用邻居状态判定，必须 ICMP。
#
# 复位命令支持**两类**，按行首自动分流（详见文件末尾 is_at_cmd / run_sh_cmd）：
#   · AT 指令     —— 行首是 AT / at（AT+CFUN=1,1、AT^HVSST=1,0、ATE0、ATI…）
#                     经本机 RPC 下发给模组，并**校验应答里的 success**
#   · 本机 shell  —— 其余任意行（ifdown MT5700M / sleep 2 / ifup MT5700M）
#                     在本机 /bin/sh 里执行，带超时保护
#
# 默认状态：**开启**（watch_enabled=1）。只做 DHCP 续约，不会主动复位模组，
# 因此即便误判也只是白续约一次，不会造成断网。
#
# 用法：
#   watchdog.sh once     只检查一次并尝试修复（给 LuCI「立即自检」用）
#   watchdog.sh daemon   常驻循环（由 /etc/init.d/mt5700-watchdog 拉起）
#
# 历史教训（别重犯）：
#   ① 「AT 分支」必须走 rpcserver 的**裸 TCP newline-JSON**（见 send_at 注释），
#      这里不是 HTTP —— 用 wget/curl 发 HTTP POST 永远失败。曾因此让 AT 指令
#      一条都没真正下发过（日志却只报「下发失败」，看不出是通道用错）。
#   ② 不要写 `A && B || C`：A 失败时会把 B 再执行一遍（命令被跑两次）。
#   ③ 不要用 `printf '%b'` 还原多行：它会顺带解释 \t \c \\ 等，
#      把 `printf 'a\tb'` 这类合法 shell 命令改坏。只翻译字面 \n。
#   ④ 循环读命令列表要用独立 fd（3<）—— 否则列表里的命令读 stdin 会把
#      剩余待执行命令吃掉。
# ============================================================================

. /lib/functions.sh

DEF_IFACE='MT5700M'
DEF_DEV='eth2'

# 探测目标默认值：腾讯 DNS（DNSPod）的公开地址。
# 国内可达性与稳定性都好，且**必须回 ICMP**（很多公共 DNS 是不回 ping 的，
# 拿那种地址当探测目标会让看门狗永远判为「不通」）。
# ★ 用 IP 而非域名：见文件头关于 DNS 劫持的说明。
DEF_GATEWAY='119.29.29.29'

# 复位命令默认值：先重拉 MT5700M 接口（纯 shell，不碰模组协议栈）。
# 刻意**不**用 AT+CFUN=1,1 作默认 —— 协议栈复位会让 eth2 数据面挂死，只宜作兜底。
DEF_RESET_CMDS='ifdown MT5700M\nsleep 2\nifup MT5700M'

# 单条 shell 命令的执行上限（秒）。防止某条命令挂住整个看门狗循环。
CMD_TIMEOUT=30
# 每条复位命令之间的间隔（秒），给模组/接口反应时间。
CMD_GAP=1
# ICMP 探测的超时与重试（秒/次）。宁可判得快一点，也不要让探测拖住整个循环。
PROBE_TIMEOUT=2
PROBE_COUNT=1

W_ENABLED=1
W_IFACE="$DEF_IFACE"
W_DEV="$DEF_DEV"
W_GATEWAY="$DEF_GATEWAY"
# icmp     = 探测 W_GATEWAY（默认模式）
# gw-neigh = 回退：自动推断默认网关 + 查邻居状态（W_GATEWAY 留空、或系统没有 ping）
W_PROBE_MODE='icmp'
W_INTERVAL=60
W_THRESHOLD=3
W_RESET_MODEM=0
W_RESET_CMDS=''
W_LOG='/tmp/at-notifications.log'
W_RPC_HOST='127.0.0.1'
W_RPC_PORT=8765
W_RPC_KEY=''
AT_LAST_ERR=''

have_ping() {
	command -v ping >/dev/null 2>&1
}

load_cfg() {
	config_load at-webserver
	config_get_bool W_ENABLED config watch_enabled 1
	config_get W_IFACE   config watch_iface "$DEF_IFACE"
	config_get W_DEV     config watch_device "$DEF_DEV"
	config_get W_INTERVAL config watch_interval 60
	config_get W_THRESHOLD config watch_fail_threshold 3
	config_get_bool W_RESET_MODEM config watch_reset_modem 0
	# 复位命令：多行文本，UCI 里以字面 \n 存储（UCI 值不能带真实换行）
	config_get W_RESET_CMDS config watch_reset_cmds "$DEF_RESET_CMDS"
	config_get W_LOG     config log_file '/tmp/at-notifications.log'
	# 探测目标。界面里填 none 表示「不做 ICMP 探测」，回退为默认网关邻居判定。
	# 注意 config_get 用的是 `:-` 语义：UCI 里存空值时也会落回默认值，
	# 所以「想关掉 ICMP 探测」只能靠 none 这个哨兵，不能靠留空。
	config_get W_GATEWAY config watch_gateway "$DEF_GATEWAY"
	case "$W_GATEWAY" in
		''|none|NONE|None) W_GATEWAY='' ;;
	esac
	# AT 下发通道：与 Rust 服务（src/rust/src/rpcserver.rs）的监听地址保持一致。
	# websocket_bind 为空时服务默认只监听 127.0.0.1（allow_wan=0）；
	# 若显式绑到了某个本机地址，就按那个地址连，否则会连不上。
	config_get W_RPC_PORT config websocket_port 8765
	config_get W_RPC_KEY  config websocket_auth_key ''
	config_get W_RPC_BIND config websocket_bind ''
	case "$W_RPC_BIND" in
		''|'0.0.0.0') W_RPC_HOST='127.0.0.1' ;;
		*)            W_RPC_HOST="$W_RPC_BIND" ;;
	esac

	[ -n "$W_IFACE" ] || W_IFACE="$DEF_IFACE"
	[ -n "$W_DEV" ] || W_DEV="$DEF_DEV"
	case "$W_INTERVAL" in ''|*[!0-9]*) W_INTERVAL=60;; esac
	[ "$W_INTERVAL" -lt 15 ] && W_INTERVAL=15
	case "$W_THRESHOLD" in ''|*[!0-9]*) W_THRESHOLD=3;; esac
	[ "$W_THRESHOLD" -lt 1 ] && W_THRESHOLD=1
	case "$W_RPC_PORT" in ''|*[!0-9]*) W_RPC_PORT=8765;; esac
	[ "$W_RPC_PORT" -lt 1 ] && W_RPC_PORT=8765

	# 决定连通性判定模式。每轮 load_cfg 都重算 —— 界面上改完最多一个检查间隔就生效。
	# 目标非空且系统有 ping → ICMP 探测；否则回退为「默认网关 + 邻居状态」。
	if [ -n "$W_GATEWAY" ] && have_ping; then
		W_PROBE_MODE='icmp'
	else
		W_PROBE_MODE='gw-neigh'
	fi
}

log_msg() {
	logger -t mt5700-watchdog "$1"
	[ -n "$W_LOG" ] && echo "$(date '+%Y-%m-%d %H:%M:%S') [watchdog] $1" >> "$W_LOG" 2>/dev/null
}

iface_up() {
	ifstatus "$W_IFACE" 2>/dev/null | grep -q '"up": true'
}

gw_of() {
	ip route show dev "$W_DEV" 2>/dev/null | awk '/^default/ {print $3; exit}'
}

gw_neigh_state() {
	gw=$(gw_of)
	[ -n "$gw" ] || { echo 'NO_GW'; return; }
	ip neigh show "$gw" dev "$W_DEV" 2>/dev/null | awk '{print $NF}' | head -n1
}

gw_ok() {
	case "$(gw_neigh_state)" in
		REACHABLE|STALE|DELAY|PROBE|PERMANENT|NOARP) return 0 ;;
		*) return 1 ;;
	esac
}

# ICMP 探测「探测目标」。
# 只认「真的收到回应」—— ping 命令能跑起来不算成功，退出码才是判据。
probe_target() {
	[ -n "$W_GATEWAY" ] || return 1
	ping -c "$PROBE_COUNT" -W "$PROBE_TIMEOUT" "$W_GATEWAY" >/dev/null 2>&1
}

# 连通性总判据（check_once 只用这一个入口，避免两套判据打架）。
connectivity_ok() {
	case "$W_PROBE_MODE" in
		icmp) probe_target ;;
		*)    gw_ok ;;
	esac
}

# 启动横幅里用的探测方式描述（把「装了没装 ping」这类前置条件明确写出来，
# 免得看门狗一直用回退判据却没人知道）。
probe_banner() {
	if [ "$W_PROBE_MODE" = "icmp" ]; then
		printf 'ICMP %s' "$W_GATEWAY"
	elif [ -n "$W_GATEWAY" ]; then
		printf '网关邻居（系统没有 ping，忽略目标 %s）' "$W_GATEWAY"
	else
		printf '网关邻居（未设置探测目标）'
	fi
}

# 「通」的时候写日志用的目标描述。
target_label() {
	if [ "$W_PROBE_MODE" = "icmp" ]; then
		printf '探测目标 %s' "$W_GATEWAY"
	else
		gw=$(gw_of)
		printf '默认网关 %s' "${gw:-未知}"
	fi
}

# 「不通」时的描述：ICMP 模式下顺带把接口/路由网关/邻居状态带出来，
# 一眼能看出到底是二层不通、还是只是外网不通。
target_fail_desc() {
	if [ "$W_PROBE_MODE" = "icmp" ]; then
		gw=$(gw_of)
		st=$(gw_neigh_state)
		printf 'ICMP 探测 %s 无回应（路由网关 %s 邻居=%s）' \
			"$W_GATEWAY" "${gw:-无}" "${st:-无}"
	else
		gw=$(gw_of)
		st=$(gw_neigh_state)
		printf '默认网关 %s 邻居状态=%s' "${gw:-未知}" "${st:-无}"
	fi
}

# 续约：优先用 ubus 的 renew（只续 DHCP 租约，不打断接口），失败再退回 ifdown/ifup
renew_lease() {
	if ubus -S call network.interface."$W_IFACE" renew >/dev/null 2>&1; then
		return 0
	fi
	ifdown "$W_IFACE" >/dev/null 2>&1
	sleep 2
	ifup "$W_IFACE" >/dev/null 2>&1
	return 0
}

# ---------------------------------------------------------------------------
# 复位命令列表的还原
# ---------------------------------------------------------------------------
# UCI 值不能带真实换行，LuCI 保存时把多行拼成以字面 \n 分隔的**单行**字符串。
# 这里只翻译「反斜杠 + n」这一种序列，其余反斜杠原样保留 —— 用 printf '%b' 会
# 顺带解释 \t / \c / \\ 等，把 `printf 'a\tb'` 这类合法命令改坏（历史教训 ③）。
split_cmds() {
	printf '%s' "$W_RESET_CMDS" | awk '{ gsub(/\\n/, "\n"); printf "%s", $0 }'
}

# ---------------------------------------------------------------------------
# 命令分流
# ---------------------------------------------------------------------------
# 判据：去掉首尾空白后，行首是 AT / at → AT 指令；其余 → 本机 shell 命令。
#
# 为什么用「AT 开头」而不是「AT+ / AT^ 开头」：
#   AT 指令族远不止 AT+/AT^ —— 还有裸 AT、ATI、ATE0、ATZ、AT&F、ATD…，
#   用 AT+/AT^ 当判据会把 ATE0 / ATI / AT 全部误判成 shell 命令去执行
#   （本机 /bin/sh 里没有 ATE0 这个命令，只会静默报 127）。
# OpenWrt / busybox 上没有以 at 开头的系统命令（at/crontab 的 at 不在 busybox 基线里），
# 所以这个前缀判据无误判风险；`ifdown MT5700M` / `sleep 2` / `ifup MT5700M` 都走 shell。
is_at_cmd() {
	case "$1" in
		[Aa][Tt]*) return 0 ;;
	esac
	return 1
}

# JSON 字符串转义（反斜杠 → \\，双引号 → \"），并压掉换行保证单行合法 JSON。
json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\r\n'
}

# 把一行 JSON 发到 Rust 服务，回显应答（单行）。
# 没有 nc 就明确失败，不静默降级成「看起来成功」。
rpc_send() {
	command -v nc >/dev/null 2>&1 || return 1
	if command -v timeout >/dev/null 2>&1; then
		printf '%s\n' "$1" | timeout 8 nc -w 5 "$W_RPC_HOST" "$W_RPC_PORT" 2>/dev/null
	else
		printf '%s\n' "$1" | nc -w 5 "$W_RPC_HOST" "$W_RPC_PORT" 2>/dev/null
	fi
}

# 下发一条 AT 指令给模组，并**校验应答**。
#
# 通道契约（src/rust/src/rpcserver.rs:4-9 / 276-313）：
#   ★ 这是裸 TCP 上「每行一个 JSON」，**不是 HTTP**。
#   请求  {"id":1,"method":"at","params":{"cmd":"AT+CSQ"[,"auth_key":"..."]}}
#   成功  {"id":1,"result":{"success":true,"data":"...","error":null}}
#   失败  {"id":1,"result":{"success":false,"data":null,"error":"..."}}
#   错误  {"id":1,"error":{"code":-32001,"message":"认证失败"}}
#   返回值与 curl/wget 无关，必须用 nc（或 socat）连上去按行收发。
#
# 判定成功只看 result.success 是否为 true —— 连得上但模组回 ERROR 也算失败，
# 避免「日志报成功、实际没执行」（官方 WebUI 的假成功就是这个毛病）。
send_at() {
	_json=$(json_escape "$1")
	if [ -n "$W_RPC_KEY" ]; then
		_key=$(json_escape "$W_RPC_KEY")
		body='{"id":1,"method":"at","params":{"cmd":"'"$_json"'","auth_key":"'"$_key"'"}}'
	else
		body='{"id":1,"method":"at","params":{"cmd":"'"$_json"'"}}'
	fi

	_resp=$(rpc_send "$body")
	_rc=$?
	if [ "$_rc" -ne 0 ] || [ -z "$_resp" ]; then
		AT_LAST_ERR="连不上后端 $W_RPC_HOST:$W_RPC_PORT（服务未运行？）"
		return 1
	fi

	case "$_resp" in
		*'"success":true'*) AT_LAST_ERR=''; return 0 ;;
	esac

	# 失败：尽量把服务端给的 error / message 文案抠出来，塞进日志便于定位
	AT_LAST_ERR=$(printf '%s' "$_resp" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
	if [ -z "$AT_LAST_ERR" ]; then
		AT_LAST_ERR=$(printf '%s' "$_resp" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
	fi
	if [ -z "$AT_LAST_ERR" ]; then
		AT_LAST_ERR="后端未返回 success=true（应答：$(printf '%s' "$_resp" | cut -c1-120)）"
	fi
	return 1
}

# 执行一条本机 shell 命令，带超时与输出捕获。
# ★ 必须写成显式 if/else：`timeout ... || /bin/sh -c ...` 在命令本身失败时
#   会把同一条命令再跑一遍（历史教训 ②）。
run_sh_cmd() {
	if command -v timeout >/dev/null 2>&1; then
		_shout=$(timeout "$CMD_TIMEOUT" /bin/sh -c "$1" 2>&1)
		_shrc=$?
	else
		_shout=$(/bin/sh -c "$1" 2>&1)
		_shrc=$?
	fi
	return "$_shrc"
}

# 复位动作：按 UCI watch_reset_cmds 的**多行、自定义**命令逐条执行（顺序执行）
#   · 支持字面 \n 作为换行（LuCI 保存时会转义）
#   · 空行与以 # 开头的行忽略（可写注释）
#   · AT 开头的行 → send_at 下发给模组并校验；其余行 → 本机 shell（带超时）
#   · 每条之间等 CMD_GAP 秒，给模组/接口反应时间
reset_modem() {
	[ -n "$W_RESET_CMDS" ] || return 1
	_tmp="/tmp/mt5700-reset-cmds.$$"
	split_cmds > "$_tmp" 2>/dev/null || { rm -f "$_tmp"; return 1; }

	_ok=1
	_n=0
	# 用 3 号 fd 读命令列表：列表里的 shell 命令若读 stdin，
	# 不会把「还没执行的行」吃掉（历史教训 ④）。
	while IFS= read -r line <&3 || [ -n "$line" ]; do
		line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/\r$//')
		[ -n "$line" ] || continue
		case "$line" in \#*) continue ;; esac

		_n=$((_n + 1))
		if is_at_cmd "$line"; then
			if send_at "$line"; then
				log_msg "复位命令 $_n/AT 已下发并确认成功：$line"
			else
				_ok=0
				log_msg "复位命令 $_n/AT 执行失败：$line | ${AT_LAST_ERR:-无应答}"
			fi
		else
			run_sh_cmd "$line"
			_shrc=$?
			if [ "$_shrc" = "0" ]; then
				log_msg "复位命令 $_n/SH 已执行：$line"
			else
				_ok=0
				_sh1=$(printf '%s' "$_shout" | tr '\n' ' ' | cut -c1-200)
				log_msg "复位命令 $_n/SH 执行失败(rc=$_shrc)：$line${_sh1:+ | $_sh1}"
			fi
		fi
		sleep "$CMD_GAP"
	done 3< "$_tmp"
	rm -f "$_tmp"

	[ "$_ok" = "1" ] && [ "$_n" -gt 0 ] && return 0
	return 1
}

# 返回：0=健康  1=已尝试修复  2=仍异常
check_once() {
	# 接口没起
	if ! iface_up; then
		log_msg "接口 $W_IFACE 未 up（模组可能未就绪），尝试拉起"
		renew_lease
		sleep 3
		iface_up && { log_msg "接口 $W_IFACE 已恢复 up"; return 1; }
		log_msg "接口 $W_IFACE 仍未 up"
		return 2
	fi

	# 接口 up，但不通 —— 正是「静默断网」的特征
	if ! connectivity_ok; then
		log_msg "不通：$(target_fail_desc)，续约 $W_IFACE"
		renew_lease
		sleep 4
		if connectivity_ok; then
			log_msg "续约成功，$(target_label) 已可达"
			return 1
		fi
		log_msg "续约后仍不通：$(target_fail_desc)"
		return 2
	fi

	return 0
}

case "$1" in
once)
	load_cfg
	check_once
	rc=$?
	case "$rc" in
		0) echo 'OK 连接正常' ;;
		1) echo 'FIXED 已自动修复' ;;
		*) echo 'FAIL 仍有异常' ;;
	esac
	exit $rc
	;;

daemon)
	load_cfg
	[ "$W_ENABLED" = "1" ] || { log_msg '看门狗未启用，退出'; exit 0; }
	_cmds_n=$(split_cmds | grep -c -v '^[[:space:]]*$' 2>/dev/null)
	[ -n "$_cmds_n" ] || _cmds_n=0
	log_msg "看门狗启动：接口=$W_IFACE 设备=$W_DEV 探测=$(probe_banner) 间隔=${W_INTERVAL}s 阈值=$W_THRESHOLD 复位模组=$W_RESET_MODEM 复位命令=${_cmds_n}条（AT/SH 自动分流，RPC=$W_RPC_HOST:$W_RPC_PORT）"
	fails=0
	while :; do
		sleep "$W_INTERVAL"
		# 每轮重新读配置，让 LuCI 改动能即时生效，无需重启服务
		load_cfg
		[ "$W_ENABLED" = "1" ] || continue
		check_once
		case $? in
			0) fails=0 ;;
			1) fails=0 ;;
			*)
				fails=$((fails + 1))
				log_msg "异常累计 $fails/$W_THRESHOLD"
				if [ "$W_RESET_MODEM" = "1" ] && [ "$fails" -ge "$W_THRESHOLD" ]; then
					log_msg "达阈值，按自定义复位命令逐条执行"
					reset_modem && fails=0
					sleep 30
				fi
				;;
		esac
	done
	;;

*)
	echo "用法: $0 {once|daemon}"
	exit 1
	;;
esac
