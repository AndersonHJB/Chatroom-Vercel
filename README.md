# Vercel 临时聊天室（无数据库 / 无 Redis）

一个可以直接部署到 Vercel 的单房间临时聊天室。

## 功能

- 普通访客无需登录即可聊天
- 管理员密码登录
- 管理员消息单独标识
- 普通访客每条消息 30 分钟后过期
- 服务端每次请求时自动剔除过期消息
- 浏览器每 15 秒清理一次过期缓存
- 浏览器 `localStorage` 缓存聊天记录
- 管理员导出 JSON
- 管理员导入 JSON
- 管理员清空当前聊天记录
- 无数据库
- 无 Redis
- 无任何第三方存储依赖

## 重要限制

本项目刻意不使用任何持久化存储。Vercel Functions 属于弹性、临时执行环境，因此：

1. 聊天数据只存在某个函数实例的内存中；
2. 冷启动、重新部署、实例回收后，服务端记录可能消失；
3. 高并发扩容时，不同实例可能暂时看到不同的内存数据；
4. `localStorage` 只保存当前访客自己浏览器最后一次看到的数据，不是服务器共享数据库。

这不是代码 Bug，而是“完全不使用存储”的架构限制。

## 部署到 Vercel

### 1. 推送到 GitHub

```bash
git init
git add .
git commit -m "init temp chat"
git branch -M main
git remote add origin git@github.com:你的用户名/vercel-temp-chat.git
git push -u origin main
```

### 2. 在 Vercel 导入仓库

直接 Import Git Repository。

本项目无需 Build Command，也无需安装依赖。

### 3. 配置管理员密码

Vercel 项目：

`Settings -> Environment Variables`

添加：

```text
ADMIN_PASSWORD=你自己的强密码
```

建议 Production / Preview / Development 都按需要配置。

保存后重新部署一次。

## 本地运行

安装 Vercel CLI：

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

然后打开终端给出的本地地址。

## JSON 格式

导出格式示例：

```json
{
  "ok": true,
  "exportedAt": "2026-08-16T07:00:00.000Z",
  "version": 1,
  "messages": [
    {
      "id": "uuid",
      "nickname": "访客A",
      "content": "你好",
      "role": "visitor",
      "createdAt": 1786863600000,
      "expiresAt": 1786865400000
    },
    {
      "id": "uuid",
      "nickname": "站长",
      "content": "欢迎",
      "role": "admin",
      "createdAt": 1786863610000,
      "expiresAt": null
    }
  ]
}
```

导入时既支持完整导出对象，也支持直接导入 `messages` 数组。

已经过期的访客消息会自动跳过，不会重新导入。
