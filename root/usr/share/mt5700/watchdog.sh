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
#   2) 网关邻居不可达        → ubus renew 续约（失败则 ifdown/ifup）
#   3) 连续失败达阈值        → 按「复位命令」逐条执行（UCI watch_reset_cmds，可多行自定义）
#                             每行按前缀自动分流：AT+… / AT^… → 下发模组；
#                             其余 → 本机 shell 命令（如 ifup MT5700M）
#
# 默认状态：**开启**（watch_enabled=1）。只做 DHCP 续约，不会主动复位模组，
# 因此即便误判也只是白续约一次，不会造成断网。
#
# 用法：
#   watchdog.sh once     只检查一次并尝试修复（给 LuCI「立即自检」用）
#   watchdog.sh daemon   常驻循环（由 /etc/init.d/mt5700-watchdog 拉起）
# ============================================================================

. /lib/functions.sh

DEF_IFACE='MT5700M'
DEF_DEV='eth2'

W_ENABLED=1
W_IFACE="$DEF_IFACE"
W_DEV="$DEF_DEV"
W_INTERVAL=60
W_THRESHOLD=3
W_RESET_MODEM=0
W_RESET_CMDS=''
W_LOG='/tmp/at-notifications.log'

load_cfg() {
	config_load at-webserver
	config_get_bool W_ENABLED config watch_enabled 1
	config_get W_IFACE   config watch_iface "$DEF_IFACE"
	config_get W_DEV     config watch_device "$DEF_DEV"
	config_get W_INTERVAL config watch_interval 60
	config_get W_THRESHOLD config watch_fail_threshold 3
	config_get_bool W_RESET_MODEM config watch_reset_modem 0
	# 复位命令：多行文本，UCI 里以字面 \n 存储（UCI 值不能带真实换行）
	# 默认「ifdown → sleep 2 → ifup」重拉 MT5700M 接口：本机实测的故障形态
	# 是模组 USB 重枚举后 DHCP 租约失效，重拉接口即可拿到新地址；
	# 刻意不用 AT+CFUN=1,1 —— 协议栈复位会让 eth2 数据面挂死，只宜作最后的兜底。
	config_get W_RESET_CMDS config watch_reset_cmds 'ifdown MT5700M\nsleep 2\nifup MT5700M'
	config_get W_LOG     config log_file '/tmp/at-notifications.log'

	[ -n "$W_IFACE" ] || W_IFACE="$DEF_IFACE"
	[ -n "$W_DEV" ] || W_DEV="$DEF_DEV"
	case "$W_INTERVAL" in ''|*[!0-9]*) W_INTERVAL=60;; esac
	[ "$W_INTERVAL" -lt 15 ] && W_INTERVAL=15
	case "$W_THRESHOLD" in ''|*[!0-9]*) W_THRESHOLD=3;; esac
	[ "$W_THRESHOLD" -lt 1 ] && W_THRESHOLD=1
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

# 通过本机 RPC 下发一条 AT 命令
send_at() {
	_json=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
	body='{"id":1,"method":"at","params":{"cmd":"'"$_json"'"}}'
	if command -v wget >/dev/null 2>&1; then
		printf '%s\n' "$body" | wget -q -O /dev/null --post-file=- \
			--header='Content-Type: application/json' \
			http://127.0.0.1:8765/ 2>/dev/null && return 0
	fi
	return 1
}

# 命令类型判定：以 AT+ / AT^ / at+ / at^ 开头（后面到行尾）视为 AT 指令；
# 其余一律当作本机 shell 命令执行。这样一条 watch_reset_cmds 就能混排两类动作，
# 默认的「先 ifdown 再 ifup 重拉接口」正是纯 shell：
#     ifdown MT5700M
#     sleep 2
#     ifup MT5700M
# 想换成协议栈级兜底时，在前面加一行 AT+CFUN=1,1 即可（注意它会让数据面短暂中断）。
is_at_cmd() {
	case "$1" in
		[Aa][Tt][+^]*) return 0 ;;
		*) return 1 ;;
	esac
}

# 复位动作：按 UCI watch_reset_cmds 的**多行、自定义**命令逐条执行（顺序执行）
#   · 支持字面 \n 作为换行（LuCI 保存时会转义）
#   · 空行与以 # 开头的行忽略（可写注释）
#   · 以 AT+/AT^ 开头的行 → send_at 下发给模组；其余行 → 本机 shell 执行
#   · 每条之间等 1 秒，给模组/接口反应时间
reset_modem() {
	[ -n "$W_RESET_CMDS" ] || return 1
	printf '%b\n' "$W_RESET_CMDS" > /tmp/mt5700-reset-cmds.$$
	_ok=1
	_n=0
	while IFS= read -r line || [ -n "$line" ]; do
		line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/\r$//')
		[ -n "$line" ] || continue
		case "$line" in \#*) continue ;; esac
		_n=$((_n + 1))
		if is_at_cmd "$line"; then
			if send_at "$line"; then
				log_msg "复位命令 $_n（AT）已下发：$line"
			else
				_ok=0
				log_msg "复位命令 $_n（AT）下发失败：$line"
			fi
		else
			# shell 命令：在同一条 sh 里执行，超时保护交给 busybox timeout（若可用）
			_shout=$(command -v timeout >/dev/null 2>&1 \
				&& timeout 30 /bin/sh -c "$line" 2>&1 \
				|| /bin/sh -c "$line" 2>&1)
			_rc=$?
			if [ "$_rc" = "0" ]; then
				log_msg "复位命令 $_n（SH）已执行：$line"
			else
				_ok=0
				log_msg "复位命令 $_n（SH）执行失败(rc=$_rc)：$line${_shout:+ | $(printf '%s' "$_shout" | tr '\n' ' ' | cut -c1-200)}"
			fi
		fi
		sleep 1
	done < /tmp/mt5700-reset-cmds.$$
	rm -f /tmp/mt5700-reset-cmds.$$
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

	# 接口 up，但网关邻居不可达 —— 正是「静默断网」的特征
	if ! gw_ok; then
		gw=$(gw_of)
		st=$(gw_neigh_state)
		log_msg "网关 ${gw:-未知} 邻居状态=${st:-无}（不通），续约 $W_IFACE"
		renew_lease
		sleep 4
		if gw_ok; then
			log_msg "续约成功，网关 $(gw_of) 已可达"
			return 1
		fi
		log_msg "续约后网关仍不可达（$(gw_of) 邻居=$(gw_neigh_state)）"
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
	_cmds_n=$(printf '%b\n' "$W_RESET_CMDS" | grep -c -v '^[[:space:]]*\(#\|$\)' 2>/dev/null || echo 0)
	log_msg "看门狗启动：接口=$W_IFACE 设备=$W_DEV 间隔=${W_INTERVAL}s 阈值=$W_THRESHOLD 复位模组=$W_RESET_MODEM 复位命令=${_cmds_n}条（AT/SH 混排）"
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
					log_msg "达阈值，按自定义复位命令逐条下发"
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
