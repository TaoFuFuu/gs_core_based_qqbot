/**
 * 不上 QQ 也能验协议：直接往 GsCore 塞一条伪消息，看它回什么。
 * 用来确认二进制帧、MessageReceive 字段、MessageSend 解析三件事对不对。
 *
 * 用法：node test-send.mjs "#帮助"
 *       node test-send.mjs "面板" group
 */

import WebSocket from 'ws'

const text = process.argv[2] || '#帮助'
const mode = process.argv[3] || 'direct'
const WS = process.env.GSCORE_WS || 'ws://127.0.0.1:8766'
const BOT_ID = process.env.GSCORE_BOT_ID || 'qq_direct'
const TOKEN = process.env.GSCORE_TOKEN || ''

const url = `${WS.replace(/\/+$/, '')}/ws/${BOT_ID}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`
console.log('连接', url)

const ws = new WebSocket(url)
let got = 0

ws.on('open', () => {
  console.log('已连接，发送：', text)
  const evt = {
    bot_id: BOT_ID,
    bot_self_id: 'bridge-test',
    msg_id: `test-${Date.now()}`,
    user_type: mode === 'group' ? 'group' : 'direct',
    group_id: mode === 'group' ? 'test_group_1' : null,
    user_id: 'test_user_1',
    sender: { nickname: '测试' },
    user_pm: 6,
    content: [{ type: 'text', data: text }],
  }
  ws.send(Buffer.from(JSON.stringify(evt), 'utf8'))
})

ws.on('message', (data, isBinary) => {
  const s = isBinary ? data.toString('utf8') : data.toString()
  let m
  try { m = JSON.parse(s) } catch { return }
  // 日志推送也走这条连接，只看带 content 的
  if (!Array.isArray(m.content)) return
  got += 1
  if (process.env.RAW === '1') {
    console.log(`\n=== 原始回复 ${got} ===`)
    console.log(JSON.stringify(m, (k, v) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 120)}…(${v.length} 字符)` : v), 2).slice(0, 3000))
    return
  }
  const plain = m.content.map((c) => c.type === 'text' ? c.data : `[${c.type}:${String(c.data).slice(0, 70)}]`).join('')
  console.log(`\n=== 回复 ${got} ===`)
  console.log('目标:', m.target_type, m.target_id)
  console.log('内容:', plain.slice(0, 500))
  const segs = m.content.map((c) => c.type)
  if (segs.some((t) => t !== 'text')) console.log('段落类型:', segs.join(','))
})

ws.on('error', (e) => console.log('错误:', e.message))

setTimeout(() => {
  console.log(`\n结束，共收到 ${got} 条回复`)
  ws.close()
  process.exit(got > 0 ? 0 : 2)
}, 20000)
