#!/usr/bin/env python3
"""只读探针：经 8765 问模组 AT^SYSCFGEX=? / ?，不碰 ttyUSB1。"""
import json
import socket
import sys

import paramiko

HOST, USER, PWD = '192.168.10.1', 'root', 'root'
CMDS = ['AT^SYSCFGEX=?', 'AT^SYSCFGEX?']


def ask(chan, cmd, cid):
    chan.sendall(json.dumps({'id': cid, 'method': 'at', 'params': {'cmd': cmd}}) + '\n')
    buf = b''
    while b'\n' not in buf:
        try:
            chunk = chan.recv(65536)
        except socket.timeout:
            return None
        if not chunk:
            break
        buf += chunk
    line = buf.split(b'\n', 1)[0]
    try:
        return json.loads(line.decode('utf-8', 'replace'))
    except Exception:
        return {'raw': line.decode('utf-8', 'replace')}


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PWD, timeout=15)
    tr = c.get_transport()
    for i, cmd in enumerate(CMDS, 1):
        # 每轮新开 channel：空闲约 60 秒会被服务端静默断开
        ch = tr.open_channel('direct-tcpip', ('127.0.0.1', 8765), ('127.0.0.1', 0))
        ch.settimeout(20)
        r = ask(ch, cmd, i)
        ch.close()
        res = (r or {}).get('result') or {}
        print('AT_CMD :', cmd)
        print('success:', res.get('success'))
        print('data   :', repr(res.get('data')))
        print('error  :', repr(res.get('error')))
        print('-' * 60)
    c.close()


if __name__ == '__main__':
    sys.exit(main())
