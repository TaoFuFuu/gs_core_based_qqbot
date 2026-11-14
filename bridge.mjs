/**
 * GsCore ⇄ QQ 官方机器人 桥
 *
 * GsCore 不是 Bot，它只认 WebSocket 上的 MessageReceive / MessageSend。
 * 这个进程站在中间：QQ 官方 SDK 收消息 → 翻成 MessageReceive 塞给 GsCore；
 * GsCore 回 MessageSend → 翻成 QQ 的 send 调用发出去。
 *
 * 协议要点（都是从 GsCore 源码里读出来的，不是猜的）：
 *   - 端点 /ws/{bot_id}，query 带 ?token=
 *   - 上行必须是 **二进制帧**，内容是 JSON（GsCore 用 websocket.receive_bytes()
 *     + msgspec.json 解码，发 text 帧它收不到）
 *   - 下行同样是二进制帧装的 JSON，字段见 MessageSend
 *   - 同一条连接上还会推日志（GsLogger），那不是消息，要按字段区分开
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, 'config.json')
const EXAMPLE_PATH = join(HERE, 'config.example.json')

const DEFAULTS = {
  gscoreUrl: 'ws://127.0.0.1:8765',
  botId: 'qq_direct',
  token: '',
  accountId: 'gscore',
  appId: '',
  appSecret: '',
  logLevel: 'info',
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    if (!existsSync(EXAMPLE_PATH)) {
      console.error('找不到 config.json，也没有 config.example.json')
      process.exit(1)
    }
    writeFileSync(CONFIG_PATH, readFileSync(EXAMPLE_PATH))
    console.log('已从示例生成 config.json，填好 appId / appSecret 再跑')
    process.exit(0)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    console.error('config.json 不是合法 JSON：' + e.message)
    process.exit(1)
  }
  const cfg = { ...DEFAULTS, ...raw }
  return cfg
}

const cfg = loadConfig()

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const MIN = LEVELS[cfg.logLevel] ?? 1
function log(level, ...args) {
  if ((LEVELS[level] ?? 1) < MIN) return
  const t = new Date().toTimeString().slice(0, 8)
  console.log(`[${t}] ${level.toUpperCase().padEnd(5)}`, ...args)
}

// ── 状态：给 /health 用，也方便排查 ──
const stats = {
  startedAt: Date.now(),
  qqOnline: false,
  wsOnline: false,
  received: 0,
  forwarded: 0,
  sent: 0,
  sendFailed: 0,
  skipped: 0,
  lastError: '',
}

const seenMessages = new Set()
function once(msgId) {
  if (!msgId) return true
  if (seenMessages.has(msgId)) return false
  seenMessages.add(msgId)
  if (seenMessages.size > 2000) {
    const first = seenMessages.values().next().value
    seenMessages.delete(first)
  }
  return true
}

// ── GsCore 侧 ──

let ws = null
let wsRetry = 0
let wsTimer = null

function wsUrl() {
  const base = cfg.gscoreUrl.replace(/\/+$/, '')
  const q = cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : ''
  return `${base}/ws/${encodeURIComponent(cfg.botId)}${q}`
}

function connectGscore() {
  const url = wsUrl()
  log('info', '正在连接 GsCore:', url.replace(/token=[^&]+/, 'token=***'))
  ws = new WebSocket(url)

  ws.on('open', () => {
    stats.wsOnline = true
    wsRetry = 0
    log('info', 'GsCore 已连上，bot_id =', cfg.botId)
  })

  ws.on('message', (data, isBinary) => {
    const text = isBinary ? data.toString('utf8') : data.toString()
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      log('debug', '收到非 JSON 帧，忽略：', text.slice(0, 80))
      return
    }
    handleFromGsCore(msg)
  })

  ws.on('close', (code) => {
    stats.wsOnline = false
    log('warn', `GsCore 断开（code ${code}），${retryDelay()}ms 后重连`)
    scheduleReconnect()
  })

  ws.on('error', (e) => {
    stats.wsOnline = false
    stats.lastError = String(e?.message || e)
    log('error', 'GsCore 连接错误：', stats.lastError)
  })
}

function retryDelay() {
  wsRetry += 1
  return Math.min(30000, 1000 * Math.pow(1.6, Math.min(wsRetry, 6)))
}

function scheduleReconnect() {
  if (wsTimer) return
  wsTimer = setTimeout(() => {
    wsTimer = null
    connectGscore()
  }, retryDelay())
}

function sendToGsCore(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('warn', 'GsCore 没连上，丢弃一条上行消息')
    stats.skipped += 1
    return
  }
  // 必须走二进制帧
  ws.send(Buffer.from(JSON.stringify(obj), 'utf8'))
}

// ── QQ ⇄ GsCore 转换 ──

/** QQ 的 message 对象 → MessageReceive */
function toMessageReceive(msg, selfOpenid) {
  const isGroup = msg.kind === 'group' || msg.kind === 'guild'
  const text = String(msg.content ?? msg.text ?? '')
  const senderId = String(msg.senderId || msg.senderOpenid || msg.openid || '')
  return {
    bot_id: cfg.botId,
    bot_self_id: String(selfOpenid || ''),
    msg_id: String(msg.id || msg.messageId || msg.msgId || ''),
    user_type: isGroup ? 'group' : 'direct',
    group_id: isGroup ? String(msg.groupOpenid || msg.channelId || '') : null,
    user_id: senderId,
    sender: { nickname: String(msg.senderName || msg.nickname || '') },
    user_pm: 6,
    content: [{ type: 'text', data: text }],
  }
}

/** MessageSend 的 content 数组 → 纯文本 */
function flattenContent(content) {
  if (!content) return ''
  const parts = []
  for (const seg of content) {
    const type = seg?.type
    const data = seg?.data
    if (type === 'text' && typeof data === 'string') {
      parts.push(data)
    } else if (type === 'at') {
      // QQ 官方对 at 的写法特殊，第一版先留空，别让整条消息发不出去
      continue
    } else if (type !== undefined) {
      log('debug', `暂不支持的段类型 ${type}，跳过`)
    }
  }
  return parts.join('')
}

/** GsCore 的 image.data：base64://xxx，也可能直接 base64:xxx */
function parseImageData(data) {
  if (typeof data !== 'string') return null
  const m = data.match(/^base64:\/\/([\s\S]+)$/) || data.match(/^base64:([\s\S]+)$/)
  if (!m) return null
  try {
    const buf = Buffer.from(m[1], 'base64')
    return buf.length > 0 ? buf : null
  } catch {
    return null
  }
}

// 图片一条条发，并发上传容易撞风控
let imageChain = Promise.resolve()

function sendImageToQQ(scope, targetId, buf) {
  imageChain = imageChain.then(async () => {
    if (!qq) {
      log('warn', 'QQ 还没启动，图丢弃')
      stats.sendFailed += 1
      return
    }
    try {
      await qq.sendImage({ scope, targetId }, { buffer: buf })
      stats.sent += 1
      log('info', `[图 ${scope}] ${Math.round(buf.length / 1024)} KB`)
    } catch (e) {
      stats.sendFailed += 1
      stats.lastError = String(e?.message || e)
      log('error', '发图失败：', stats.lastError)
    }
  })
  return imageChain
}

/**
 * 把段列表摊平。
 * GsCore 有时把东西包在 node（合并转发卡片）里，扫码登录的二维码就是这么发的：
 *   MessageSegment.node([MessageSegment.image(...)])
 * 所以遇到 node 要递归拆开，否则里面再好的图也看不见。
 */
function flattenSegments(content, depth = 0) {
  const out = []
  if (depth > 5) return out
  for (const seg of content || []) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'node') {
      const inner = seg.data
      if (Array.isArray(inner)) {
        out.push(...flattenSegments(inner, depth + 1))
      } else if (inner && Array.isArray(inner.content)) {
        out.push(...flattenSegments(inner.content, depth + 1))
      } else if (inner && Array.isArray(inner.messages)) {
        out.push(...flattenSegments(inner.messages, depth + 1))
      } else if (typeof inner === 'string') {
        out.push({ type: 'text', data: inner })
      } else {
        log('warn', 'node 段结构不认识：' + JSON.stringify(inner).slice(0, 200))
      }
      continue
    }
    out.push(seg)
  }
  return out
}

function handleFromGsCore(msg) {
  // 同一连接上混着日志推送，没有 content/target 字段的一律不当消息
  if (!msg || typeof msg !== 'object') return
  const hasTarget = msg.target_type || msg.target_id
  const hasContent = Array.isArray(msg.content)
  if (!hasTarget && !hasContent) return

  const targetId = msg.target_id || msg.group_id || msg.user_id
  if (!targetId) {
    log('warn', 'MessageSend 缺 target_id，丢弃：', JSON.stringify(msg).slice(0, 120))
    return
  }

  const scope = msg.target_type === 'group' || msg.target_type === 'channel' ? 'group' : 'c2c'
  const segs = flattenSegments(msg.content)

  let hadImage = false
  for (const seg of segs) {
    if (seg.type !== 'image') continue
    hadImage = true
    const buf = parseImageData(seg.data)
    if (!buf) {
      log('warn', `图片数据不认识：${String(seg.data).slice(0, 32)}`)
      stats.skipped += 1
      continue
    }
    sendImageToQQ(scope, targetId, buf)
  }

  const text = flattenContent(segs)
  if (text) {
    sendToQQ(scope, targetId, text)
  } else if (!hadImage) {
    log('warn', `跳过一条只含 [${segs.map((c) => c?.type ?? '?').join(',')}] 的回复`)
    stats.skipped += 1
  }
}

// ── QQ 侧 ──

let qq = null

async function startQQ() {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
  qq = new QQBot({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    accountId: cfg.accountId,
  })

  qq.on?.('ready', () => {
    stats.qqOnline = true
    log('info', 'QQ 机器人已就绪')
  })

  qq.use(async (ctx, next) => {
    const msg = ctx?.message
    if (!msg) return next?.()
    const msgId = String(msg.id || msg.messageId || msg.msgId || '')
    if (!once(msgId)) return next?.()

    stats.received += 1
    const text = String(msg.content ?? msg.text ?? '').trim()
    if (!text) {
      log('debug', '空消息，跳过')
      return next?.()
    }

    const evt = toMessageReceive(msg, ctx?.bot?.selfId || '')
    log('info', `[${evt.user_type}] ${text.slice(0, 40)}`)
    sendToGsCore(evt)
    stats.forwarded += 1
    // 不调 next()：GsCore 是唯一的下游，别让 SDK 再往下传
  })

  await qq.start?.()
  stats.qqOnline = true
  log('info', 'QQ 机器人已启动')
}

const pendingReplies = new Map()

async function sendToQQ(scope, targetId, text) {
  if (!qq) {
    log('warn', 'QQ 还没启动，回复丢弃')
    stats.sendFailed += 1
    return
  }
  const key = `${scope}:${targetId}`
  // 同一条连接上的连续回复：合并成一条，少打扰
  if (pendingReplies.has(key)) {
    const p = pendingReplies.get(key)
    p.parts.push(text)
    return
  }
  const entry = { parts: [text], timer: null }
  pendingReplies.set(key, entry)
  entry.timer = setTimeout(async () => {
    pendingReplies.delete(key)
    const merged = entry.parts.join('\n').slice(0, 1800)
    try {
      await qq.send({ target: { scope, targetId }, content: merged })
      stats.sent += 1
      log('info', `[回复 ${scope}] ${merged.slice(0, 40)}`)
    } catch (e) {
      stats.sendFailed += 1
      stats.lastError = String(e?.message || e)
      log('error', '发送失败：', stats.lastError)
    }
  }, 300)
}

// ── 收尾 ──

function shutdown(sig) {
  log('info', `收到 ${sig}，正在退出`)
  try { ws?.close() } catch {}
  try { qq?.stop?.() } catch {}
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ── 启动 ──

log('info', '桥启动')
log('info', `GsCore: ${cfg.gscoreUrl}  bot_id: ${cfg.botId}`)
connectGscore()

if (!cfg.appId || !cfg.appSecret) {
  log('warn', 'appId / appSecret 还没填，QQ 没有启动')
  log('warn', '编辑 config.json 填上这两个值，然后重启这个进程')
} else {
  startQQ().catch((e) => {
    log('error', 'QQ 启动失败：', String(e?.message || e))
    log('error', '凭据不对的话，改 config.json 再重启')
  })
}

// 每 60 秒打一行状态，方便判断桥是否还活着
setInterval(() => {
  log('debug', '状态', JSON.stringify({
    qq: stats.qqOnline,
    ws: stats.wsOnline,
    recv: stats.received,
    fwd: stats.forwarded,
    sent: stats.sent,
    fail: stats.sendFailed,
  }))
}, 60000)
