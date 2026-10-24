---
name: har-replay-lab
description: 把一个已登录的 Web 应用（HAR 录制）还原成本地可运行的前端，接口用录到的真实响应重放，用于研究它的功能设计、页面状态机和交互流程。当用户说"把某个网站/SPA 跑在本地""研究这个产品是怎么做的""分析这个页面的流程"，或者需要在不接触后端的情况下复现一个前端时使用。
---

# HAR Replay Lab

把线上 Web 应用录下来，在本地跑起来。

## 什么时候用

- 用户想**研究某个产品的前端实现和功能设计**，而不是要它的源码
- 用户想**复现一个 SPA 的交互流程**，但没有后端
- 用户想**验证某个 mock 是否覆盖了完整流程**

不适用：想拿后端逻辑/算法（拿不到）；想复刻别人产品去发布（别做）。

## 前提

1. Node ≥ 22
2. 一个开着远程调试端口的 Chrome（Chrome 136+ 禁止默认 profile 开调试口）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-replay
```

这个 profile 是空的，**要在里面重新登录一次目标站点**。这是唯一必须人做的动作。

## 流程

```
capture → to-site → to-fixtures → serve → walk
```

### 1. capture

```bash
node scripts/capture.mjs --url <目标地址>
```

提示后让用户在窗口里把每个页面/选项卡都点一遍，走一次完整核心流程，回车导出。

**关键**：录制时要把「每个分支的入口」都点一次。没走过的分支，后面重放必然 404。

### 2. to-site

```bash
node scripts/to-site.mjs captures/xxx.har
```

读输出的体检报告，重点看三行：

- `HTML: N 个` —— 如果是 0，说明导出时过滤器停在 Fetch/XHR，必须重录
- `source map` —— 有的话可以直接在 DevTools Sources 里看原始文件树，能真正读代码
- `接口 N 个` —— 决定下一步 mock 的规模

### 3. to-fixtures

```bash
node scripts/to-fixtures.mjs captures/xxx.har
```

同一端点多次调用会存成 `__1 __2 __3` 按序回放。

### 4. serve

```bash
node scripts/serve.mjs
```

打开录制的那个路由。看终端输出和 `logs/misses.jsonl`，缺哪个接口就回原站补录。

### 5. walk（验证）

```bash
node scripts/walk.mjs --base http://127.0.0.1:8787 --path /app
```

自动登录 → 提问 → 点按钮 → 判定出图。出图（退出码 0）说明 mock 覆盖到结果页了。

## 判断与决策

| 信号 | 含义 | 动作 |
|---|---|---|
| `served: 0` | 没有静态资源 | HAR 没抓到 HTML，重录 |
| 卡在登录页 | 缺 `/api/auth/login` | 通常录制时已登录所以 HAR 里没有；to-fixtures 会从 `/auth/refresh` 补一份 |
| 某个接口 404 | 那条分支没录过 | 回原站走一遍该分支，重录，再跑 to-fixtures |
| 界面内容对不上 | fixtures 混了不同会话 | 一次录制只装一条完整会话，不要拼接 |

## 铁律

**不要用另一个会话的响应去补当前会话的缺口。**

这类前端是纯状态驱动的：服务端返回什么，界面就渲染什么。拼两段录像会造出一个不存在的状态，
界面立刻错乱，而且错误会累积。宁可让它 404 —— 404 是清晰的信号，假数据是污染。

## 合规

- 只处理用户有权访问的页面
- 产物只用于本地学习/研究，不部署、不分发、不商用
- 不绕过任何认证或访问控制
- 录下来的 HAR 可能含 Cookie，提醒用户不要外传
