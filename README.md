# Vercel 临时聊天室 + WebRTC P2P 文件直传

一个可以直接部署到 Vercel 的单房间临时聊天室。

## 功能

- 普通访客无需登录即可聊天
- 管理员密码登录
- 管理员消息单独标识
- 普通访客每条文字消息 30 分钟后过期
- 浏览器 `localStorage` 缓存文字聊天记录
- 管理员导入 / 导出 JSON
- 管理员清空聊天
- 图片、视频、压缩包、安装包等任意文件 P2P 直传
- 支持一次选择多个文件
- 支持选择单个在线用户或全部在线用户
- 图片 / 视频接收后可直接预览
- 文件通过 WebRTC DataChannel 传输，文件二进制不上传 Vercel
- 无数据库、无 Redis、无 Blob、无第三方持久化存储

## P2P 文件传输原理

```text
发送方浏览器 ──────────────── 接收方浏览器
             WebRTC DataChannel
             文件二进制直传

       \                       /
        \── Vercel /api/chat ─/
             只交换 SDP 信令
```

Vercel 只看到：

- 页面静态资源
- 聊天文字 API
- 在线状态
- WebRTC SDP offer / answer

Vercel **不会接收文件二进制内容**。

### 为什么没有 TURN？

本项目刻意不配置 TURN 中继，因为 TURN 会把文件流量经过中继服务器，不再是纯直连。

因此：

- 普通家庭宽带 / 手机网络通常可以直连；
- 某些对称 NAT、公司、校园、严格防火墙环境可能无法建立 P2P；
- 直连失败时项目不会偷偷改走 Vercel 中转。

## 大文件说明

代码按 64KB 分块发送，因此不受 Vercel 请求体大小限制。

但是当前浏览器接收端会先把分块保存在内存，全部接收完后再生成 Blob 下载。因此超大文件仍受浏览器可用内存限制。实践上建议单文件控制在几百 MB 以内；如果需要稳定传输数 GB / 数十 GB，需要进一步接入 File System Access API 进行接收端流式落盘。

## 重要限制：完全无持久化存储

Vercel Functions 属于弹性、临时执行环境。本项目又明确不使用数据库 / Redis，因此：

1. 文字聊天和 WebRTC 信令只存在某个 Function 实例的内存中；
2. 冷启动、扩容、重新部署可能清空服务端内存；
3. 多 Function 实例时可能看到不同的临时内存状态；
4. P2P 两端必须同时在线；
5. 文件不会进入 JSON，也不会进入 localStorage；刷新后接收记录里的 Blob 下载链接会消失；
6. 纯 P2P 信令在 Vercel 多实例情况下不能做到企业级 100% 可靠。这是“不使用任何共享存储”的直接结果。

## Vercel 用量

文件二进制通过 WebRTC 在客户端之间直传，因此文件大小本身不占 Vercel Fast Data Transfer。

Vercel 用量主要来自：

- 用户第一次访问下载 HTML/CSS/JS；
- `/api/chat` 普通前台约每 10 秒轮询一次、后台标签页约每 60 秒一次；
- P2P 握手期间会短暂加速轮询；
- 发送文字消息、管理员操作和少量 P2P SDP 信令。

所以如果在线人数非常多并且页面长时间保持打开，请求次数会比文件流量更值得关注。

## 部署到 Vercel

### 1. 推送 GitHub

```bash
git init
git add .
git commit -m "init temp p2p chat"
git branch -M main
git remote add origin git@github.com:你的用户名/vercel-temp-chat.git
git push -u origin main
```

### 2. Vercel 导入仓库

直接 Import Git Repository。

本项目无 npm 依赖，无需 Build Command。

### 3. 配置管理员密码

Vercel 项目：

`Settings -> Environment Variables`

添加：

```text
ADMIN_PASSWORD=你自己的强密码
```

保存后重新部署。

## 本地运行

```bash
npm i -g vercel
```

创建 `.env.local`：

```bash
ADMIN_PASSWORD=12345678
```

运行：

```bash
vercel dev
```

WebRTC 在生产环境需要安全上下文；Vercel 自带 HTTPS，部署后无需额外配置证书。
