# gs_core_based_qqbot

让 **GsCore（早柚核心）直接对接 QQ 官方机器人**，中间不再需要 AstrBot。

```
QQ 官方服务器 ──SDK──▶ 这个桥 ──WebSocket(二进制帧)──▶ GsCore
                        ◀────── MessageSend ─────────
```

原来的链路是 `QQ → AstrBot → 适配器插件 → GsCore`。AstrBot 在里面只干一件事：
把 QQ 的消息翻成 GsCore 的格式。这个项目把那层顶掉，少一个进程、少一处配置、少一个能挂的地方。

---

## 做了什么

### 1. 写了一个 QQ 官方 ⇄ GsCore 的协议桥

`bridge.mjs`，一个文件，约 400 行。两个方向：

**上行**（QQ → GsCore）：SDK 收到消息 → 拼成 `MessageReceive` → 以二进制帧发给 `/ws/{bot_id}`

**下行**（GsCore → QQ）：收到 `MessageSend` → 把段列表拆开 → 文本走 `send`、图片走 `sendImage`

### 2. 摸清了 GsCore 的 WS 协议

这部分是照着一行行源码读出来的，不是照 OneBot 猜的。猜会全错。

| 项 | 事实 | 对应源码 |
|---|---|---|
| 端点 | `/ws/{bot_id}?token={WS_TOKEN}` | `core.py` `websocket_endpoint` |
| 帧类型 | **二进制帧**。GsCore 用 `websocket.receive_bytes()` 收 | `core.py:155` |
| 帧内容 | UTF-8 的 JSON，字段见 `MessageReceive` | `handler.py:59` `msgjson.decode` |
| 下行 | 同样是二进制帧装的 JSON，`MessageSend` | `bot.py:737` `send_bytes` |
| 同连接复用 | 日志推送（`GsLogger`）也走这条连接，要按字段筛掉 | `gs_logger.py:30` |

上行长这样：

```json
{
  "bot_id": "qq_direct",
  "bot_self_id": "",
  "msg_id": "消息ID",
  "user_type": "group",
  "group_id": "群 openid",
  "user_id": "发送者 openid",
  "sender": { "nickname": "" },
  "user_pm": 6,
  "content": [{ "type": "text", "data": "#面板" }]
}
```

### 3. 处理了三个会踩的坑

**坑一：发 text 帧收不到。**
GsCore 用的是 `receive_bytes()`，只认二进制帧。Node 的 `ws.send(string)` 发的是 text 帧，GsCore 一个字节都收不到，而且不报错。必须 `ws.send(Buffer.from(json))`。

**坑二：图片被包在 `node` 里。**
扫码登录的二维码是这么发的（`qrlogin.py:111`）：

```python
im.append(MessageSegment.image(qrcode_base64))
await bot.send(MessageSegment.node(im))
```

`node` 是合并转发卡片，二维码在里面。只认 `image` 的桥会把它整个丢掉，表现就是"扫码登录没反应"。桥里对 `node` 做了递归展开，里面是什么都能挖出来。

**坑三：图片是 base64 内联，不是 URL。**
GsCore 发出来的 `image` 段长这样：

```
base64:///9j/4AAQSkZJRgABAQAAAQABAAD...
```

前缀是 `base64://`，后面是标准 base64。要解成 Buffer 再交给 SDK 的 `sendImage(target, { buffer })`。

### 4. 为什么不做配置页

GsCore 自己的网页控制台改不了——它的前端是编译好的 dist，仓库的 AGENTS.md 里明确禁止往那里写构建产物。而且 GsCore 本来也不管 QQ 凭据，它只等别人连上来。

试过给桥单独做一页，后来去掉了。现在配置就 `config.json` 一份文件，六个字段，改完重启。够了。

---

## 怎么生效

### 第零步：装 GsCore（已经有了就跳过这节）

GsCore 不是单文件程序，是个 Python 服务，得先装起来。

**1. 准备 uv**

GsCore 用 uv 管依赖，别用系统 pip。

```bash
# Windows
winget install --id=astral-sh.uv -e
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**2. 拉代码、装依赖**

```bash
git clone https://github.com/Genshin-bots/gsuid_core.git
cd gsuid_core
uv sync --python 3.12
```

**3. 先起一次**

```bash
uv run core
```

第一次启动会在 `data/` 下生成配置、数据库、日志。能看到 `http://127.0.0.1:8765/app` 打开就成功了，按 Ctrl+C 停下。

**4. 装游戏插件**

浏览器开 `http://127.0.0.1:8765/app`，进插件页搜名字装：

- `GenshinUID` —— 原神
- `StarRailUID` —— 崩铁
- `ZZZeroUID` —— 绝区零

命令行装也行：

```bash
cd gsuid_core/gsuid_core/plugins
git clone https://github.com/KimigaiiWuyi/GenshinUID.git
```

星铁和绝区零的仓库地址以控制台里显示的为准，别照抄这里——那两个的镜像换过几次。

装完重启 core，日志里应该出现插件加载成功的记录。

**5. 记下 WS_TOKEN**

控制台 → 配置 → 找 `WS_TOKEN`。桥要填同一个值。

桥和 GsCore 在同一台机器上、走回环地址的话，这个可以留空——GsCore 的 `TRUSTED_IPS` 包含 `localhost` / `127.0.0.1` / `::1`。

### 第一步：启动 GsCore

```bash
uv run core                    # 默认 127.0.0.1:8765
uv run core --port 8766        # 或者换个端口
```

记下端口，等下填到桥的 `gscoreUrl` 里。

### 第二步：装依赖

```bash
npm install --omit=dev --registry https://registry.npmmirror.com
```

只有两个依赖：`@tencent-connect/qqbot-nodejs` 和 `ws`。

### 第三步：填配置

```bash
cp config.example.json config.json
```

```json
{
  "gscoreUrl": "ws://127.0.0.1:8765",
  "botId": "qq_direct",
  "token": "",
  "accountId": "gscore",
  "appId": "QQ 机器人 AppID",
  "appSecret": "QQ 机器人 AppSecret",
  "logLevel": "info"
}
```

四个要点：

- **`botId` 用一个新名字**（比如 `qq_direct`）。如果和 AstrBot 现在用的同一个，GsCore 会当成同一条连接的重连，可能把 AstrBot 那条踢下线。这样两边可以并存、对比。
- `accountId` 随便，只是 SDK 内部标识。
- `appId` / `appSecret` 填 QQ 开放平台里那个机器人的。
- `config.json` 已经在 `.gitignore` 里，不会进仓库。

### 第四步：跑

```bash
node bridge.mjs
```

正常的启动日志长这样：

```
桥启动
GsCore: ws://127.0.0.1:8765  bot_id: qq_direct
正在连接 GsCore: ws://127.0.0.1:8765/ws/qq_direct
GsCore 已连上，bot_id = qq_direct
QQ 机器人已就绪
```

四行齐了就是通了。缺 `GsCore 已连上` 说明地址或 token 不对；缺 `QQ 机器人已就绪` 说明 AppID / AppSecret 不对。

### 第五步：验证

在新机器人上发一条：

```
#uid
```

桥的日志里应该出现：

```
[direct] #uid
[回复 c2c] 你还没有绑定过uid哦! ...
```

QQ 那边收到这句，整条链路就通了。

再发 `#帮助` 或 `#面板` 验证图片：

```
[direct] #帮助
[图 c2c] 650 KB
```

---

## 不上 QQ 也能验协议

`test-send.mjs` 可以绕过 QQ，直接往 GsCore 塞一条伪消息，看它回什么。调协议的时候比反复发真消息快得多。

```bash
node test-send.mjs "#uid"              # 私聊
node test-send.mjs "#面板" group       # 群聊
RAW=1 node test-send.mjs "#帮助"       # 打印完整 JSON，含段结构
```

环境变量：`GSCORE_WS`（默认 `ws://127.0.0.1:8766`）、`GSCORE_BOT_ID`、`GSCORE_TOKEN`。

这个脚本在开发期很有用——它让我们在没连 QQ 的情况下就确认了二进制帧格式、`MessageReceive` 字段、命令触发、`MessageSend` 解析这四件事全对。

---

## 已知限制

**只处理文本和图片。** `at`、`voice`、`video`、`file` 这些段会被跳过并在日志里写明类型。

**QQ 风控没做专门处理。** 图片是串行发的（避免并发上传撞限制），文本有 300ms 合并窗口，但没有按账号做速率限制。消息量大的话要自己加。

**没有重连退避上限。** GsCore 断开后按指数退避重连，最长 30 秒一次。

**不处理群聊 @。** QQ 官方对 at 的写法和其他平台不同，暂时跳过。

---

## 文件

```
bridge.mjs              主程序，全部逻辑
test-send.mjs           不上 QQ 的协议测试脚本
config.example.json     配置模板
config.json             实际配置（已 gitignore）
package.json            依赖
```

---

## 和 AstrBot 的取舍

**去掉 AstrBot 得到什么**：少一个进程、少一处配置、少一个故障点、省一点内存。在你那条链路里 AstrBot 只干协议转换，多平台支持、插件生态、网页配置都没用上。

**丢掉什么**：多平台适配能力（以后要接别的平台得自己写）、AstrBot 的插件生态、它自带的网页管理。

**建议的切换方式**：不要让桥直接顶掉 AstrBot。给桥用一个不同的 `botId`，两边同时在线，比对同样几条命令的输出。稳几天再关 AstrBot。
