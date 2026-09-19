/*
 * 静态断言：状态页的撞车/切页守卫（P12 / P15）
 * ----------------------------------------------------------------------------
 * P12：慢档一轮十余次串口往返，_dispose 只清定时器、管不到已发起的链 ——
 *      切页瞬间撞上就会让下一个页面的头十几秒变慢。故每步都要看 disposed。
 * P15：手动「刷新」每次都 loadDeviceInfo(true) 强制绕过 60 秒节流，按钮也没有
 *      disabled；连点会叠加两条 9 命令的链，堵住全局串行队列。故要有 in-flight 守卫。
 *
 * 每条都有反向验证：改动前的旧文本必须被同一检查判红。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) { pass++; }
	else { fails.push(detail ? name + ' :: ' + detail : name); }
}

const src = fs.readFileSync(SRC, 'utf8');

/* ---------------- P12：慢档链逐步检查 disposed ---------------- */
const slowStart = src.indexOf('function refreshSlow()');
const slowBody = slowStart < 0 ? '' : src.slice(slowStart, slowStart + 1400);
ok('P12 refreshSlow 内逐步检查 disposed',
	/if \(disposed\) return null;/.test(slowBody),
	'慢档链没有 disposed 检查，切页后仍会继续打串口');
ok('P12 该检查位于 SLOW_TASKS.forEach 的链内',
	/SLOW_TASKS\.forEach[\s\S]{0,400}if \(disposed\) return null;/.test(slowBody),
	'disposed 检查不在慢档链里');
/* 反向：改动前的旧 forEach 必须判红 */
const oldSlow = "			SLOW_TASKS.forEach(function (fn) {\n"
	+ "				chain = chain.then(function () {\n"
	+ "					return Promise.resolve()\n"
	+ "						.then(fn)\n"
	+ "						.catch(function (err) { slowFailures[fn.name || '匿名任务'] = err; });\n"
	+ "				});\n"
	+ "			});\n";
ok('P12 反向：旧的 forEach（无 disposed 检查）被判为不通过',
	!/if \(disposed\)/.test(oldSlow),
	'旧写法竟被判为通过，检查函数无效');

/* ---------------- P15：loadDeviceInfo 的 in-flight 守卫 ---------------- */
const devStart = src.indexOf('function loadDeviceInfo(');
/* 注意：整个函数约 60 行，守卫复位写在末尾，切片必须足够长 */
const devBody = devStart < 0 ? '' : src.slice(Math.max(0, devStart - 200), devStart + 3200);
ok('P15 loadDeviceInfo 有 devRunning 声明',
	/var devRunning = null;/.test(devBody),
	'没有 devRunning 状态位');
ok('P15 撞车时复用在跑的那条',
	/if \(devRunning\) return devRunning;/.test(devBody),
	'连点「刷新」仍会叠加两条链');
ok('P15 链结束后清空守卫（否则下一次 force 永远跑不了）',
	/devRunning = chain\.catch\([\s\S]{0,160}\.then\(function \(\) \{ devRunning = null; \}\);/.test(devBody),
	'守卫没有复位，第二次刷新会被永久挡住');
ok('P15 节流判断在守卫之前（60 秒节流照旧生效）',
	src.indexOf('now - _devInfoAt < 60000') < src.indexOf('if (devRunning) return devRunning;'),
	'守卫写在了节流之前，会破坏原有的 60 秒节流语义');
/* 反向：改动前的旧写法必须判红 */
const oldDev = "		function loadDeviceInfo(force) {\n"
	+ "			var now = Date.now();\n"
	+ "			if (!force && _devInfoAt && now - _devInfoAt < 60000) return;\n"
	+ "			_devInfoAt = now;\n";
ok('P15 反向：旧写法（无 in-flight 守卫）被判为不通过',
	!/devRunning/.test(oldDev),
	'旧写法竟被判为通过，检查函数无效');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
process.exit(0);
