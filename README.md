# ima2api

> **本仓库说明（aishen1 fork）**
>
> 基于上游 [1icc0/ima2api](https://github.com/1icc0/ima2api)，本 fork 增加了：
>
> - **多账号支持** —— 账号池 + 轮询 + 故障切换；一个账号登录失效自动切下一个，
>   全部不可用才报错。会话按「账号+会话」隔离，不会串台
> - **网页配置页**（`GET /`）—— 粘贴 Cookie 添加账号、启停/改名/删除、
>   查看调用地址与 API Key、一键复制、检测有效性、手动续期。**无需再手工编辑 config.json**
> - **账号有效性显示** —— 区分「有效 / 已失效 / 异常 / 缺凭据 / 已停用 / 未验证」，
>   并把「凭据失效」与「网络抖动」分开，避免网络一抖就误让你重新抓包
> - **服务内置自动续期** —— 每 2 分钟检查、提前约 20 分钟刷新；
>   **刷新后无需重启进程**（旧版把 Cookie 读进内存，每次刷新都得重启）
> - **飞牛 fnOS 应用包（.fpk）** —— 见 [`fpk/`](fpk/)，自带 node 运行时，
>   安装后从桌面图标打开配置页。打包脚本：[`fpk/build.sh`](fpk/build.sh)
> - **`ima_autorefresh.py`** —— 不依赖 `registration_id` 的 Cookie 自动刷新器
>   （实测 `ima.qq.com/auth_login/refresh` 根本不校验该字段，上游 `ima_runner.py`
>   第 91 行的检查反而会拦掉刷新）。**新版的自动续期已内置到 server.js，
>   此脚本仅在用旧版 server.js 时才需要**
> - **`config.example.json`** —— 凭据占位模板（真实 `config.json` 已被 .gitignore）
>
> 详见《多账号与网页配置》与《自动刷新》两节。
>
> ---


逆向 IMA App 的 AI API，封装为 **OpenAI Chat Completions** 和 **Anthropic Messages** 兼容格式，支持 **tool calling**（prompt 注入方式）。

一次抓包即可，之后都会自动刷新cookie。

## 快速开始

### 方式一：网页配置（推荐）

```bash
npm install
node server.js
# 打开 http://<本机IP>:8081/  → 粘贴 Cookie 添加账号
```

服务会自动生成含随机 API Key 的 `config.json`，账号与 Key 的变化立即落盘。

### 方式二：手工配置

```bash
cd ima2api
npm install
cp config.example.json config.json   # 然后手工填 cookie
node server.js
```

### 飞牛 fnOS 一键安装包

```bash
./fpk/build.sh                                   # 生成 fpk/ima2api.fpk
appcenter-cli install-fpk fpk/ima2api.fpk
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `IMA2API_CONFIG_DIR` | 配置文件所在目录（默认脚本同目录）。fpk 安装时指向应用数据目录，使配置在升级后保留 |
| `IMA2API_PORT` | 监听端口，优先于 `config.json` 的 `server.port` |

## 配置

### 推荐：用网页配置页

打开 `http://<本机IP>:8081/`，粘贴 Cookie 即可添加账号，支持多账号。
服务首次启动会自动生成 `config.json`（含随机 API Key），无需手写。

### 手工编辑 config.json

```json5
{
  "server": { "port": 8081, "host": "0.0.0.0" },
  "api_keys": ["sk-ima-请自定一个密钥"],
  "default_model": "deepseek-v4-flash",
  "accounts": [
    {
      "id": "<自动生成，可留空>",
      "name": "主号",
      "cookie": "IMA-GUID=...; IMA-UID=...; IMA-TOKEN=...; IMA-REFRESH-TOKEN=...",
      "refresh_token": "<抓 IMA-REFRESH-TOKEN，用于自动续期>",
      "enabled": true
    }
  ],
  "models": { "hy3": { "type": 0, "id": "official_0", "think_type": 2, "think_id": "official_2", "name": "Hy3" } }
}
```

> 旧版单账号格式（`auth.cookie`）**会被自动迁移**成 `accounts[0]`，无需手工转换。

### 获取 Cookie

**方式一：网页扫码登录（推荐，1.0.8+）**

打开配置页 → 「扫码登录」→ 用微信扫一扫，登录成功后账号**自动加入列表**，无需抓包、无需粘贴。

原理（`POST /admin/qr/login`）：

1. 配置页用 iframe 内嵌 ima 官方登录页 `https://ima.qq.com/login#/login-qr-only`
2. 用微信扫码，ima 登录页通过 `postMessage` 把微信 `code` 发给宿主页面
   （事件名 `loginWxCodeReady`，页面只接受来自 `https` + `ima.qq.com` 的消息）
3. 宿主页面把 `code` 交给后端 → 后端调 `ima.qq.com/auth_login/login` 换取
   `token` / `refreshToken` / `userId`
4. 服务端组装成 `x-ima-cookie` 落库，并**立刻发一次真实请求校验**，确认这枚凭证可用

> 为什么要绕这一圈：微信开放平台的 `redirect_uri` 白名单只放行 `https://ima.qq.com/login`，
> `code` 不可能直接回调到 NAS 地址。ima 的登录页本身实现了把 `code` 用 `postMessage`
> 交给宿主的能力，我们直接复用它，所以**全程不需要浏览器插件、不需要抓包**。

**方式二：手工粘贴 Cookie**

1. 手机安装 IMA App，QQ/微信登录
2. 配置 HTTPS 代理（mitmproxy / Charles / Fiddler）
3. 发送任意消息，复制请求头里的 `x-ima-cookie` **完整值**（其中已含 `IMA-REFRESH-TOKEN`）
4. 粘贴到配置页即可 —— 无需再单独抓 `https://ima.qq.com/auth_login/refresh`

两种方式获得的凭证等价，都一样能自动续期。

## 多账号与网页配置

配置页（`GET /`）提供：

| 功能 | 说明 |
|------|------|
| **扫码登录** | 内嵌微信二维码，扫码即自动添加账号（1.0.8+） |
| 添加账号 | 粘贴 Cookie 即可，可加任意多个 |
| 有效性显示 | **有效 / 已失效 / 异常 / 缺凭据 / 已停用 / 未验证** 六态徽标 |
| 剩余有效期 | 由「最近续期时间 + 接口返回的有效秒数」推算，临近过期变橙色警示 |
| 检测全部账号 | 一次并发探测所有启用账号，真实请求验证 Cookie |
| 立即续期 | 用 `refresh_token` 换新 token，无需重启服务 |
| 启停 / 改名 / 删除 | 停用的账号不参与调用 |
| 调用信息 | 直接显示完整的 OpenAI / Anthropic 地址（含内网 IP 与端口）与 API Key，可一键复制 |
| 自定义调用地址 | 地址不对（多网卡 / 反向代理 / 域名）时，可手动指定前缀，留空即自动检测 |
| 重新生成 Key | **替换**当前 Key（只保留一个），旧 Key 立即失效 |

### 调用地址是怎么来的

页面上的地址**以服务端返回值为准**，始终是「协议 + 内网 IP + 端口 + `/v1`」的完整形式：

1. 配置里的 `server.public_base`（在配置页「地址不对？手动指定」里设置，优先级最高）
2. 服务端算出的地址：**本机内网 IP + 实际监听端口**，即 `http://192.168.9.102:8088/v1`
3. 兜底：浏览器当前访问地址（仅当上面都拿不到时）

第 2 条是默认且最常用的路径。服务端**不再采信请求的 `Host` 头**，
原因是这套服务现在以 iframe 方式内嵌在飞牛 App 里，页面的访问地址是飞牛网关
（`http://NAS:5666/app/ima2api/`），拿它当调用地址对调用方毫无意义；
而「内网 IP + 端口」在任何设备上都直连可用。

> 历史坑：早期版本按请求 `Host` 推算地址，手机经 App 中继访问时 Host 里带不出端口，
> 页面就显示成 `/v1` 半截内容。后来改成浏览器地址优先，内嵌后又变成网关地址。
> 现在统一由服务端给出内网 IP + 端口，不再受访问路径影响。

页面上的地址与 Key 使用可断行的完整显示（不再横向裁切），
复制按钮在 `http://` 局域网下也能用（`navigator.clipboard` 只在安全上下文可用，
已自动回退到 `execCommand`）。

### 内嵌到飞牛 App（不跳转、不走公网）

桌面入口使用飞牛的应用内嵌机制，点图标直接在 App 里打开配置页，不新开浏览器标签：

```json
{
  ".url": {
    "ima2api.Application": {
      "type": "iframe",
      "gatewaySocket": "app.sock",
      "gatewayPrefix": "/app/ima2api",
      "url": "/app/ima2api/"
    }
  }
}
```

- `cmd/main` 启动服务时同时监听两处：TCP `0.0.0.0:8088`（对外提供 API）
  和 unix socket `<安装目录>/app.sock`（供飞牛网关转发）
- 飞牛的 `trim_http_cgi` 会把 `/app/ima2api/...` **原样**转发到该 socket，
  所以服务端会剥掉 `IMA2API_BASE_PATH` 前缀再走路由；
  页面里的请求也会自动带上该前缀（服务端通过 `<meta name="ima2api-basepath">` 注入）
- 这条链路全程在本机完成，**不经过公网**，因此不受外部入口/中继影响；
  内网 IP 变更也不影响它

配置页标题右侧会显示版本标记（如 `v1.0.6`），用来一眼确认当前打开的是哪一版页面；
`/` 与 `/admin/state` 响应都带 `Cache-Control: no-store`，避免网页视图缓存旧页面。

### 账号调度

- 每次请求按**轮询**选账号，失败则**自动切下一个**；全部失败才报错
- 会话按「账号 + 会话」隔离，多账号之间不会串台
- 鉴权失败（登录过期）与网络抖动**区别对待**：前者换账号，后者重试

### 有效性状态含义

| 状态 | 含义 | 建议 |
|------|------|------|
| 有效 | 最近一次真实调用成功 | — |
| 已失效 | 上游明确回鉴权失败 | 重新粘贴 Cookie，或点「立即续期」 |
| 异常 | 非鉴权错误（超时/断连） | 点「测试」复查，通常重试即可 |
| 缺凭据 | 没有 Cookie | 更新 Cookie |
| 已停用 | 手动停用 | 点「启用」恢复 |
| 未验证 | 刚添加，尚未发起请求 | 点「测试」 |

### 账号状态字段（供脚本读取）

`GET /admin/state` 返回每个账号的 `state`、`remain_seconds`、`expire_at`、
`last_ok`、`last_check`、`last_error`、`last_error_kind` 等。

> ⚠️ 管理接口（`/admin/*`）**仅允许内网/本机访问**，公网来源返回 403。

## API 端点

### OpenAI 兼容 (`/v1`)

```bash
# 模型列表
curl http://localhost:8080/v1/models -H "Authorization: Bearer YOUR_KEY"

# 普通对话
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5-3-flash","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"glm-5-3-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'

# Tool calling
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model":"glm-5-3-flash",
    "messages":[{"role":"user","content":"执行 uname -a"}],
    "tools":[{
      "type":"function",
      "function":{"name":"Bash","description":"执行命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}
    }],
    "tool_choice":"auto"
  }'

# Tool 结果回传 (多轮)
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model":"glm-5-3-flash",
    "messages":[
      {"role":"user","content":"执行 uname -a"},
      {"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\"command\":\"uname -a\"}"}}]},
      {"role":"tool","tool_call_id":"call_1","content":"Linux ..."}
    ]
  }'
```

### Anthropic 兼容 (`/v1`)

```bash
# 流式对话
curl http://localhost:8080/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"glm-5-3-flash","max_tokens":1024,"messages":[{"role":"user","content":"你好"}],"stream":true}'

# Tool use
curl http://localhost:8080/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model":"glm-5-3-flash",
    "max_tokens":1024,
    "messages":[{"role":"user","content":"执行 pwd"}],
    "tools":[{"name":"Bash","description":"执行命令","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]
  }'
```

## Tool Calling 机制

采用 **prompt 注入** 方式实现 function calling：

```
## CRITICAL — YOU MUST USE FUNCTION CALLING

<function name="Bash">
<description>执行 bash 命令</description>
<parameters>{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}</parameters>
</function>

## HOW TO CALL A FUNCTION
输出 <function_call>{"name":"...","arguments":{...}}</function_call>，然后立即停止。
```

工作流：
1. 客户端发送 `tools` 参数 → 服务器将工具定义注入 prompt
2. IMA 模型输出 `<function_call>…</function_call>` → 服务器解析为 `tool_calls` / `tool_use` 返回
3. 客户端本地执行工具 → 将结果回传
4. 服务器检测到 `tool_use` + `tool_result` → 用 `⚠️ 系统通知` 格式告知模型结果
5. 模型基于结果直接回答用户

特性：
- 最多展示 8 个工具（截断保护）
- Schema 自动压缩（去掉 `$schema`/`$defs`/`$ref` 等元数据）
- 自动检测中文用户 → 要求中文回复
- 会话自动复用（基于首条消息 hash）

## 可用模型

模型列表**启动时自动从 IMA 官方接口同步**（`POST ima.qq.com/cgi-bin/model_manage/get_models`，免登录），
与 IMA 客户端「内置模型」完全一致，无需手工维护。当前官方提供 4 个：

| 模型 ID | 底座 | 思考模式 |
|---------|------|----------|
| `deepseek-v4-flash` | DeepSeek-V4-Flash | `deepseek-v4-flash-think` |
| `hy3` | 混元 Hy3 | `hy3-think` |
| `hy4-preview` | 混元 Hy4 preview | `hy4-preview-think` |
| `glm-5-3-flash` | GLM-5.3-Flash | `glm-5-3-flash-think` |

思考模式是官方模型下的**子模型**（`sub_model_infos`），不单独列入 `/v1/models`，
用 `-think` / `-reasoning` 后缀调用；也接受模型显示名（如 `GLM-5.3-Flash`）或裸 `model_type` 数字。
管理页有「同步模型」按钮可随时手动同步；上游不可用时自动沿用上次的模型表，不影响服务。

## 认证

- `Authorization: Bearer <key>` 或 `x-api-key: <key>`
- 支持配置多个 API Key

## 客户端集成

### OpenAI SDK (Python)

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-key")
response = client.chat.completions.create(
    model="glm-5-3-flash",
    messages=[{"role": "user", "content": "你好"}],
    tools=[{"type":"function","function":{"name":"Bash","description":"执行命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],
    stream=True
)
for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Anthropic SDK (Python)

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://localhost:8080/v1", api_key="your-key")
with client.messages.stream(
    model="glm-5-3-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

## 局限性

- IMA 模型需要 prompt 注入才能触发 tool calling（非原生支持）
- 流式输出中的 `<function_call>` 块会被服务器端过滤（客户端不可见）
- IMA 会话限制约 20 轮，超出后需重新建立


---

## 自动刷新

### ✅ 新版已内置（推荐）

`server.js` 自带自动续期，**无需任何外部脚本**：

- 每 2 分钟检查一次，token（有效期约 2h）提前约 20 分钟自动刷新
- 刷新后**不需要重启进程** —— 每次请求现算请求头，刷完立即生效
- 配置页每个账号有「立即续期」按钮，可手动触发
- 没有 `refresh_token` 的账号会被跳过（只能重新粘贴 Cookie）

只需在添加账号时让 `refresh_token` 有值 —— 从 `x-ima-cookie` 里的
`IMA-REFRESH-TOKEN` 自动提取，抓包时无需额外操作。

> **实测结论**：`refresh_token` **不会轮换**，同一个可长期反复使用。

### 旧版：外部刷新脚本 `ima_autorefresh.py`

仅在你使用**旧版 server.js** 时才需要下面这套。

#### 问题

上游 `ima_runner.py` 要求 `config.json` 里 `auth.registration_id` 非空：

```python
# ima_runner.py:91
if not registration_id:
    return None      # ← 直接拒绝刷新
```

但抓 `registration_id` 很麻烦（需要抓 `https://ima.qq.com/auth_login/refresh` 请求体）。

#### 实测结论：根本不需要它

对 `https://ima.qq.com/auth_login/refresh` 直接发请求：

| registration_id | 结果 |
|---|---|
| 空字符串 `""` | `code=0` ✅ |
| 完全省略该字段 | `code=0` ✅ |

**服务端不校验这个字段。** 而且 `refresh_token` **不会轮换**（刷新只返回新 token），
所以一份 refresh_token 可以无限使用。

#### 用法

```bash
# 常驻：自动刷新 + 保活（推荐）
python3 ima_autorefresh.py

# 只刷一次（给 cron 用）
python3 ima_autorefresh.py --once

# 查看状态
python3 ima_autorefresh.py --check
```

行为：
- Token 每 2h 过期 → **提前 10 分钟**自动刷新
- 刷新后**自动重启 server.js** 加载新 token
- server.js / 刷新器挂了 → 自动拉起
- 每 2 分钟检查一次；日志写 `ima_autorefresh.log`

#### 开机自启（fnOS 示例）

配 `ima2api-boot.sh`（幂等），然后 crontab：

```cron
@reboot /bin/bash /path/to/ima2api-boot.sh >/dev/null 2>&1
*/5 * * * * /bin/bash /path/to/ima2api-boot.sh >/dev/null 2>&1
```
