# -*- coding: utf-8 -*-
"""eSIM / eUICC 通路只读探测。

★ 设计前提（与本项目其它真机脚本一致）：
  - 走 SSH direct-tcpip 到 127.0.0.1:8765 下发 AT，**不直接开 /dev/ttyUSB1**，
    不与 Rust 服务争串口，不需要停服务、不会断网。
  - **全程只读**：只发 SELECT / GET DATA 这类取数 APDU，不下发任何写命令，
    不需要 lpac，不需要在设备上装任何东西。

判定链：
  ① AT+CSIM 在不在
  ② SELECT ISD-R（默认 AID A0000005591010FFFFFFFF8900000100）
     - 6A82 / 6A88 → 卡上没有 eUICC（本项目当前就是这条）
  ③ 选上了 → 发 ES10c GetEID，拿到 32 位 EID 即证明 ES10x 通路打通

用途：换 eUICC 卡后第一条要跑的命令。跑通再决定要不要做页面 / 装 lpac。

用法：
    python tools/esim-probe.py                  # 默认 ISD-R AID
    python tools/esim-probe.py A000000559...    # 某些测试卡用别的 AID
"""
import json
import re
import sys

import paramiko

HOST = '192.168.10.1'
USER = 'root'
PW = 'root'
PORT = 8765

DEFAULT_ISDR_AID = 'A0000005591010FFFFFFFF8900000100'

# APDU 模板里的占位符，{aid} / {cla} 会被替换
SEL_LOGICAL = '00A4040C10{aid}'      # 选中并激活到「下一个可用逻辑通道」
SEL_BASIC = '00A4040010{aid}'        # 基本通道（部分卡不允许辅助逻辑通道选 ISD-R）
GET_EID = '{cla}E2910006BF3E035C015A'   # ES10c GetEID
CLOSE_CHANNEL = '0070800100'         # 关逻辑通道 1

# ISO 7816 常见 SW
SW_TEXT = {
    '9000': '成功',
    '6A82': '未找到该应用/文件（卡上没有这个 AID）',
    '6A88': '未找到引用数据',
    '6A81': '功能不支持（卡不支持逻辑通道）',
    '6A80': '数据域参数错误',
    '6985': '使用条件不满足',
    '6A86': 'P1/P2 不正确',
    '6B00': '参数错误',
    '6200': '警告：无信息返回（通常也算成功）',
}


def sw_mean(sw):
    if sw is None:
        return '无响应'
    if sw in SW_TEXT:
        return SW_TEXT[sw]
    if sw.startswith('61') or sw.startswith('9F'):
        return '成功且有数据待取（%s）' % sw
    if sw[:2] == '90':
        return '成功'
    if sw[0] == '6':
        return '错误 SW=%s' % sw
    return 'SW=%s' % sw


class Modem(object):
    def __init__(self):
        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.client.connect(HOST, username=USER, password=PW, timeout=12)
        self.tr = self.client.get_transport()
        self.seq = 0

    def close(self):
        self.client.close()

    def at(self, cmd):
        """下发一条 AT，返回原始响应文本（失败返回 None）。"""
        self.seq += 1
        try:
            ch = self.tr.open_channel('direct-tcpip', ('127.0.0.1', PORT), ('127.0.0.1', 0))
        except Exception as exc:
            return None, 'open channel failed: %r' % (exc,)
        ch.settimeout(20)
        payload = (json.dumps({'id': self.seq, 'method': 'at', 'params': {'cmd': cmd}}) + '\n')
        ch.send(payload.encode())
        buf = b''
        try:
            while not buf.endswith(b'\n'):
                d = ch.recv(65536)
                if not d:
                    break
                buf += d
        except Exception:
            pass
        ch.close()
        try:
            obj = json.loads(buf.decode('utf-8', 'replace').strip())
        except Exception:
            return None, buf.decode('utf-8', 'replace').strip()
        res = obj.get('result') or {}
        if not res.get('success'):
            return None, (res.get('error') or 'unknown error')
        return res.get('data') or '', None

    def csim(self, apdu):
        """经 AT+CSIM 发一条 APDU，返回 (data_hex_含SW, sw_hex, err)。"""
        apdu = apdu.upper()
        cmd = 'AT+CSIM=%d,"%s"' % (len(apdu), apdu)
        raw, err = self.at(cmd)
        if err:
            return None, None, err
        m = re.search(r'\+CSIM:\s*\d+,\s*"([0-9A-Fa-f]*)"', raw)
        if not m:
            return None, None, raw.strip()
        resp = m.group(1).upper()
        if len(resp) < 4:
            return '', resp, None
        return resp[:-4], resp[-4:], None


def main():
    aid = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ISDR_AID).upper()
    aid = aid.replace(' ', '')
    if len(aid) != 32 or re.match(r'^[0-9A-F]+$', aid) is None:
        print('ISD-R AID 必须是 32 个十六进制字符（16 字节），收到：%s' % aid)
        return 2

    print('目标：%s    ISD-R AID = %s' % (HOST, aid))
    print('=' * 66)

    m = Modem()
    try:
        raw, err = m.at('AT+CSIM=?')
        if err:
            print('① AT+CSIM 不可用：%s' % err)
            print('   → 这条通道不通，eSIM 管理在本模组上无从谈起。')
            return 1
        print('① AT+CSIM 可用：%s' % raw.strip().replace('\r\n', ' '))
        print('')

        # 卡在位确认：读 ICCID(2FE2) 与 IMSI(6F07)
        iccid = ''
        data, sw, err = m.csim('00A40804022FE2')
        if sw and sw.startswith('9') or sw and sw.startswith('61'):
            data, sw, err = m.csim('00B000000A')
            if data:
                b = [data[i:i + 2] for i in range(0, len(data), 2)]
                # EF_ICCID 是 BCD 反序：每个字节内高 4 位是后一个数字、低 4 位是前一个数字，
                # 所以是「字节内半字节互换」，不是相邻字节对调。长度奇数时末半字节为 F 填充。
                iccid = ''.join(x[1] + x[0] for x in b).rstrip('F')
        print('② 卡槽里的卡：ICCID = %s' % (iccid or '读不到'))
        print('')

        # ③ 两种通道各试一次
        eid = None
        for label, tpl, cla in (
            ('逻辑通道', SEL_LOGICAL, '01'),
            ('基本通道', SEL_BASIC, '00'),
        ):
            apdu = tpl.format(aid=aid)
            print('③ SELECT ISD-R（%s）%s' % (label, apdu))
            data, sw, err = m.csim(apdu)
            if err:
                print('   失败：%s' % err)
                continue
            print('   → SW=%s  %s' % (sw, sw_mean(sw)))
            if not sw or not (sw == '9000' or sw.startswith('61') or sw.startswith('9F')):
                continue

            d2, sw2, err2 = m.csim(GET_EID.format(cla=cla))
            print('   ④ ES10c GetEID（CLA=%s）→ SW=%s' % (cla, sw2))
            if d2:
                print('      原始：%s' % d2)
                g = re.search(r'5A10([0-9A-F]{32})', d2)
                if g:
                    eid = g.group(1)
            m.csim(CLOSE_CHANNEL)
            if eid:
                break

        print('')
        print('=' * 66)
        if eid:
            print('结论：eUICC 在位，ES10x 通路打通。')
            print('  EID = %s' % eid)
            print('  → 可以进入下一步：装 lpac，按 stdio + bridge 方案接 8765。')
            return 0
        print('结论：没有检出 eUICC。')
        print('  → 卡槽里是普通 USIM，需要先换成可移除 eUICC 卡再跑本脚本。')
        return 1
    finally:
        m.close()


if __name__ == '__main__':
    sys.exit(main())
