#!/bin/sh
# run-e2e.sh — 本地端到端链路验证（无硬件环境）
#
# 链路：RPC 客户端(等价 rpcd ucode 插件) → Rust 后端(127.0.0.1:8765) → mock 模组(TCP 20249)
#
# 前置：Rust 后端已 release 编译（src/rust/target/release/at-webserver）
#       mock-modem 目录已 npm install（ws 包）
#
# 用法：sh run-e2e.sh

set -e
cd "$(dirname "$0")"

export PATH=/opt/nodejs/22/bin:$PATH
export RUSTUP_HOME=/home/user/.rust
export CARGO_HOME=/home/user/.cargo
export PATH="$PATH:/home/user/.cargo/bin"

RUST_BIN="../../src/rust/target/release/at-webserver"
[ -x "$RUST_BIN" ] || { echo "未找到 $RUST_BIN，请先编译：cd src/rust && cargo build --release"; exit 1; }

# 假 uci 注入 PATH，让后端读到 127.0.0.1:20249 的测试配置
MOCK_DIR="$(pwd)"
chmod +x mock-modem.js e2e-test.js mock-uci
# 后端执行的是 "uci"，提供同名可执行入口
ln -sf mock-uci "$MOCK_DIR/uci"
export PATH="$MOCK_DIR:$PATH"

#
# ⚠️ 安全守卫（永恒铁律：所有测试禁止高危操作）
#
# 下面要用 `fuser -k 20249/tcp 8765/tcp` 清掉端口占用 —— 在真机上那正是
# 正在运行的 AT 后端，一杀就是线上服务中断。所以先确认这里不是真机：
# 有真实模组串口、或有注册中的 at-webserver 服务，就拒绝执行。
for dev in /dev/ttyUSB0 /dev/ttyUSB1 /dev/ttyUSB2; do
	if [ -e "$dev" ]; then
		echo "检测到真实模组串口 $dev，拒绝执行（本脚本会 fuser -k 清端口）" >&2
		exit 1
	fi
done
if command -v ubus >/dev/null 2>&1; then
	if ubus list service 2>/dev/null | grep -q at-webserver; then
		echo "检测到真实的 at-webserver 服务在运行，拒绝执行" >&2
		exit 1
	fi
fi

echo "==> 1/4 清理残留并启动 mock 模组 (TCP 20249)"
fuser -k 20249/tcp 2>/dev/null || true
fuser -k 8765/tcp 2>/dev/null || true
sleep 0.3
node mock-modem.js 20249 > /tmp/mock-modem.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID $RUST_PID 2>/dev/null || true' EXIT
sleep 0.5

echo "==> 2/4 启动 Rust 后端 (RPC 127.0.0.1:8765)"
"$RUST_BIN" > /tmp/at-webserver-rust.log 2>&1 &
RUST_PID=$!
sleep 1.5

echo "==> 3/4 运行 RPC 端到端测试"
# set -e 下 node 一旦失败会立刻退出脚本，后面的清理与日志打印全部不可达，
# 排查时看不到后端日志。这里临时放开，自己接住退出码。
set +e
node e2e-test.js 8765 test-key-123
E2E_RC=$?
set -e

echo "==> 4/4 清理"
kill $RUST_PID $MOCK_PID 2>/dev/null || true
sleep 0.3
echo "--- mock 模组日志 ---"
tail -8 /tmp/mock-modem.log
echo "--- Rust 后端日志 ---"
tail -8 /tmp/at-webserver-rust.log

exit $E2E_RC
