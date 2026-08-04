# yz-login 第三方系统集成 API 调用指南

## 概述

yz-login 是统一登录中转平台。接入后，用户只需在 yz-login 登录一次，即可免密进入你的系统；若用户已在宜众（YZ）登录，还可通过宜众单点登录（SSO）直接免密进入 yz-login，全程无需输入账号密码。

**平台地址**: `http://192.168.0.8`

---

## 两种接入方式

| 方式 | 适用场景 | 登录入口 |
|------|---------|---------|
| **方式一：ticket 回调（通用）** | 任意第三方系统 | 用户访问 yz-login 登录页，登录后带 ticket 跳回 |
| **方式二：宜众 SSO 免密** | 已部署宜众、希望"宜众已登录就免登" | 宜众门户点击模块，自动验票免密进 yz-login |

两种方式可共存。方式二是方式一的上游：宜众 SSO 让用户免登进入 yz-login，y z-login 再用 ticket 机制让用户免登进入你的系统。

---

## 方式一：ticket 回调接入（3 步）

### 第 1 步：在 yz-login 管理后台注册应用

1. 用 grigs 账号登录 yz-login
2. 进入「管理后台」
3. 在「自建系统」区域点击「注册应用」
4. 填写应用名称和你的系统首页 URL，点击保存
5. 系统会自动生成一个 **应用密钥（app_secret）**，记下来

### 第 2 步：在你的系统中添加登录跳转

当用户未登录时，将浏览器跳转到 yz-login，并带上回跳地址。`from` 参数支持三种写法：

**方式一：直接 URL（原有）**
```
http://192.168.0.8/login?from=http://你的系统地址/你的回调页面
```

**方式二：按应用 ID 引用（推荐）**

不用写死 URL，引用管理后台「自建系统」里注册的应用 ID，URL 变更时自动跟随：
```
http://192.168.0.8/login?from=id:1
```

**方式三：按应用名引用**
```
http://192.168.0.8/login?from=app:ak47
```

用户在 yz-login 完成登录后，会自动跳回你的系统，并携带一个 `ticket` 参数：

```
http://你的系统地址/你的回调页面?ticket=xxx
```

### 第 3 步：用 ticket 换取用户信息

你的后端收到 ticket 后，调用 yz-login 的验证接口：

**请求：**
```
GET http://192.168.0.8/api/ticket/verify?ticket=xxx
```

**成功响应（HTTP 200）：**
```json
{
  "ok": true,
  "id": 1,
  "username": "10015200",
  "display_name": "张三",
  "is_admin": 0
}
```

**失败响应（HTTP 403）：**
```json
{
  "ok": false,
  "msg": "ticket 无效或已过期"
}
```

**注意：ticket 一次性使用，验证后立即失效，有效期 5 分钟。**

---

## 方式二：宜众 SSO 免密登录

用户在宜众已登录时，访问 yz-login 不再输入账号密码——通过宜众标准 SSO 体系（`token.do` + `user.do`）自动验票登录。

### 原理

yz-login 把自己注册为宜众的一个"第三方系统"。用户从宜众门户点击模块，宜众校验当前会话后生成一次性 `sso_token` 并 302 跳到 yz-login 的 `/yz/callback`，yz-login 服务端再回调宜众 `user.do` 验票换取用户身份，建立本地会话。

```
用户浏览器              宜众(192.168.0.29:8090)         yz-login(192.168.0.8)
   │ 已登录宜众                 │                            │
   │─ 点门户模块 ───────────────>│                            │
   │  /sso/token.do?url=        │                            │
   │   http://192.168.0.8/yz/callback                        │
   │                            │ 校验会话 + 白名单           │
   │<─ 302 /yz/callback?sso_token=XXX ──────────────────────>│
   │                            │<── /sso/user.do?sso_token ─│ 服务端验票
   │                            │─── {userId,userName,...} ─>│
   │                            │              查/建本地用户
   │<────────────────────── 写 session，302 到 /portal ──────│
```

**sso_token 要点**：
- 由宜众加密生成，有效期 24 小时；
- 密钥派生为 JDK `SHA1PRNG` 私有行为，Python 不可复现 → **yz-login 不本地解密，必须调 `user.do` 验票**。

### 第 1 步：宜众侧配置白名单

在宜众服务器 `yz.xml` 增加配置项 `sso_allow_urls`，配置接收 sso_token 的地址（存在多个用逗号隔开）：

```xml
<add id="sso_allow_urls" value="http://192.168.0.8/yz/callback"/>
```

> **白名单为整串精确匹配（忽略大小写）**，回调地址必须与此一字不差（协议、主机、端口、路径全一致）。

### 第 2 步：宜众侧增加门户模块

在宜众增加一个模块：
- **类型**：`popupurl`
- **地址**：
```
/sso/token.do?url=http://192.168.0.8/yz/callback
```

> 必须通过**宜众门户点击模块**触发，不能在浏览器地址栏直接输入该链接。
> 原因：宜众模块系统在打开链接时会**自动注入当前登录用户的会话 token**；直接访问没有 token，token.do 会返回"请求身份不合法！"。

### 第 3 步：yz-login 侧（已内置，无需开发）

yz-login 已实现 `/yz/callback` 路由，自动完成：
1. 接收 `sso_token` 参数
2. 服务端回调宜众 `user.do` 验票（容错解析响应，兼容宜众响应多段 JSON 拼接）
3. 按 `userId` 查/建 `relay_users`（不存在则按默认组自动创建）
4. 写入会话，跳转 `/portal`（支持 `from` 参数按应用跳转）

### 验证

- 宜众已登录 → 点模块 → 1~2 秒无感进入 yz-login 门户 ✅
- 宜众未登录 → token.do 返回"请求身份不合法！"，需先在宜众登录
- 直接访问 yz-login（无宜众会话）→ 维持现有账号密码登录，完全向后兼容

### 错误处理

| 情况 | 表现 | 处理 |
|------|------|------|
| 宜众未登录点模块 | token.do 返回"请求身份不合法！" | 用户先在宜众登录 |
| 回调地址不在白名单 | token.do 返回"url参数不正确。" | 核对 `sso_allow_urls` 与模块地址逐字符一致 |
| sso_token 无效/过期 | user.do 返回 errorCode | 回落账号密码登录 |
| user.do 连接失败 | 提示"连接宜众失败" | 检查 yz-login 到宜众网络 |

---

## API 接口参考

### 1. 登录页面

```
GET /login?from={回调地址}
```

跳转到 yz-login 的登录页面。登录成功后跳回 `回调地址?ticket=xxx`。

`from` 参数支持三种写法：

| 写法 | 说明 | 示例 |
|------|------|------|
| `http://...` / `https://...` | 直接 URL（原有方式） | `from=http://你的系统/回调` |
| `id:<应用ID>` | 引用管理后台注册的应用，URL 变更自动跟随（推荐） | `from=id:1` |
| `app:<应用名>` | 按应用名引用 | `from=app:ak47` |

### 2. 验证 Ticket

```
GET /api/ticket/verify?ticket={ticket字符串}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ticket | string | 是 | 回调 URL 中获取的 ticket |

**返回字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| ok | boolean | 是否验证成功 |
| id | int | 用户 ID |
| username | string | 用户名（yz 用户为 UserID） |
| display_name | string | 显示姓名 |
| is_admin | int | 是否管理员（1=是，0=否） |

### 3. 检查登录状态

```
GET /api/auth/check
```

返回当前 session 的登录状态（需要同域 Cookie）。

**成功响应：**
```json
{ "ok": true, "user_id": 1, "username": "10015200" }
```

**未登录：** HTTP 401 `{ "ok": false }`

### 4. 登出

```
GET /logout?from={回调地址}
```

清除 yz-login 的登录会话。`from` 参数同样支持 `http://`、`id:`、`app:` 三种写法；指定时登出后跳转回该地址，未指定则回到 yz-login 登录页。

### 5. 宜众 SSO 回调（方式二专用）

```
GET /yz/callback?sso_token={宜众token.do返回的sso_token}[&from={回调地址}]
```

由宜众 `token.do` 自动 302 调用，无需手动请求。收到后服务端验票并建立会话，`from` 参数走与登录相同的权限校验（`_check_from_access`）。

---

## 权限校验

所有 `from` 跳转目标（含 ticket 回调和 SSO 回调）都经过统一权限校验：

1. **目标必须是已注册且启用的应用**（按 origin `scheme://host:port` 匹配 `app_url`）
2. **用户所在组在该应用的 `allowed_groups` 内**（或应用设为 `all`）

**管理员（is_admin=1）**放行组校验，但仍要求目标是已注册应用。

未注册或无权限的目标一律拒绝，防止 ticket 绕过门户组过滤、防止回调端点被用作开放重定向器。

---

## 完整示例

### Python (Flask) 示例（方式一：ticket 回调）

```python
from flask import Flask, request, redirect, session, jsonify
import requests

app = Flask(__name__)
app.secret_key = 'your-secret-key'

YZ_LOGIN_URL = 'http://192.168.0.8'
MY_CALLBACK = 'http://你的系统地址/callback'


@app.route('/')
def index():
    """首页 - 未登录则跳转到 yz-login"""
    if 'user' not in session:
        return redirect(f'{YZ_LOGIN_URL}/login?from={MY_CALLBACK}')
    return f"欢迎，{session['user']['display_name']}！"


@app.route('/callback')
def callback():
    """yz-login 登录成功后的回调页面"""
    ticket = request.args.get('ticket')
    if not ticket:
        return '缺少 ticket', 400

    # 用 ticket 向 yz-login 验证
    resp = requests.get(f'{YZ_LOGIN_URL}/api/ticket/verify', params={'ticket': ticket})
    if resp.status_code != 200 or not resp.json().get('ok'):
        return '登录验证失败', 403

    # 验证成功，保存用户信息到 session
    user = resp.json()
    session['user'] = user
    return redirect('/')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(f'{YZ_LOGIN_URL}/logout?from={MY_CALLBACK}')


if __name__ == '__main__':
    app.run(port=8000)
```

### Java (Spring Boot) 示例

```java
@Controller
public class LoginController {

    private static final String YZ_LOGIN_URL = "http://192.168.0.8";
    private static final String MY_CALLBACK = "http://你的系统地址/callback";

    @GetMapping("/")
    public String index(HttpSession session) {
        if (session.getAttribute("user") == null) {
            return "redirect:" + YZ_LOGIN_URL + "/login?from=" + MY_CALLBACK;
        }
        return "index";
    }

    @GetMapping("/callback")
    public String callback(@RequestParam String ticket, HttpSession session) {
        RestTemplate restTemplate = new RestTemplate();
        String url = YZ_LOGIN_URL + "/api/ticket/verify?ticket=" + ticket;
        
        ResponseEntity<Map> resp = restTemplate.getForEntity(url, Map.class);
        Map body = resp.getBody();
        
        if (resp.getStatusCode() == HttpStatus.OK && body != null && Boolean.TRUE.equals(body.get("ok"))) {
            session.setAttribute("user", body);
            return "redirect:/";
        }
        return "redirect:" + YZ_LOGIN_URL + "/login?from=" + MY_CALLBACK;
    }
}
```

### JavaScript (Node.js + Express) 示例

```javascript
const express = require('express');
const session = require('express-session');
const axios = require('axios');

const app = express();
app.use(session({ secret: 'your-secret', resave: false, saveUninitialized: true }));

const YZ_LOGIN = 'http://192.168.0.8';
const CALLBACK = 'http://你的系统地址/callback';

app.get('/', (req, res) => {
    if (!req.session.user) {
        return res.redirect(`${YZ_LOGIN}/login?from=${CALLBACK}`);
    }
    res.send(`欢迎，${req.session.user.display_name}！`);
});

app.get('/callback', async (req, res) => {
    const { ticket } = req.query;
    if (!ticket) return res.status(400).send('缺少 ticket');

    try {
        const resp = await axios.get(`${YZ_LOGIN}/api/ticket/verify`, { params: { ticket } });
        if (resp.data.ok) {
            req.session.user = resp.data;
            return res.redirect('/');
        }
    } catch (e) {}
    res.redirect(`${YZ_LOGIN}/login?from=${CALLBACK}`);
});

app.listen(8000);
```

---

## 注意事项

- **Ticket 一次性**：每个 ticket 只能用一次，用完即废
- **有效期 5 分钟**：超时未验证自动失效
- **同域要求**：yz-login 和你的系统需要在同一网络可访问
- **用户角色**：`is_admin` 字段可用于判断用户在你的系统中的权限
- **yz 用户名**：通过 yz 系统登录的用户，`username` 字段是 yz 的 UserID（数字）
- **宜众 SSO 前提**：方式二需宜众管理员配置 `sso_allow_urls` 白名单 + 门户模块，且用户已登录宜众
- **跨域限制**：宜众与 yz-login 不同域，无法通过浏览器 cookie 自动识别宜众登录态，必须走 token.do 回调
