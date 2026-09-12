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
#   3) 连续失败达阈值        → 可选复位模组协议栈（AT+CFUN=1,1）
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
W_LOG='/tmp/at-notifications.log'

load_cfg() {
	config_load at-webserver
	config_get_bool W_ENABLED config watch_enabled 1
	config_get W_IFACE   config watch_iface "$DEF_IFACE"
	config_get W_DEV     config watch_device "$DEF_DEV"
	config_get W_INTERVAL config watch_interval 60
	config_get W_THRESHOLD config watch_fail_threshold 3
	config_get_bool W_RESET_MODEM config watch_reset_modem 0
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

# 复位模组协议栈（可选，最后手段）
reset_modem() {
	body='{"id":1,"method":"at","params":{"cmd":"AT+CFUN=1,1"}}'
	if command -v wget >/dev/null 2>&1; then
		printf '%s\n' "$body" | wget -q -O /dev/null --post-file=- \
			--header='Content-Type: application/json' \
			http://127.0.0.1:8765/ 2>/dev/null && return 0
	fi
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
	log_msg "看门狗启动：接口=$W_IFACE 设备=$W_DEV 间隔=${W_INTERVAL}s 阈值=$W_THRESHOLD 复位模组=$W_RESET_MODEM"
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
					log_msg "达阈值，复位模组协议栈（AT+CFUN=1,1）"
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
