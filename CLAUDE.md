# file-share-app

AE买量脚本产品展示站 + 后台管理系统。前端纯静态 HTML，后端 Express，部署在腾讯云 CloudBase。

## 关于仓库所有者

- 称呼：你（中文交流）
- 操作系统：Windows 11
- 代码风格偏好：别写注释、别过度抽象、别加半成品功能
- 本仓库就是全部信息源，不需要再问我要凭证或配置
- GitHub: qingmoyyds | Gitee: qingmoyyds

## CloudBase 环境

- 环境 ID: `ceshishiyong-d1gb3vg9y56ee3be6`
- 线上 API 地址: `https://ceshishiyong-d1gb3vg9y56ee3be6.service.tcloudbase.com/apiv2`
- 静态托管域名: 同上环境
- 数据库集合: `users`, `files`, `content`
- 如需部署/操作线上 → 先 `tcb login`

## 架构

```
用户浏览器
  ├── public/index.html    (产品展示页，公开)
  ├── public/admin.html    (后台管理，需登录)
  │
  ▼ API 请求自动适配:
  │   localhost → 同源 /api/*
  │   线上 → CloudBase 云函数
  │
  ▼ Express (两种运行模式)
  ├── server.js            (本地开发，JSON 文件存储)
  └── cloudfunctions/api/  (线上部署，CloudBase DB + 云存储)
```

## 本地运行

```bash
npm install
npm start
# 打开 http://localhost:3000
# 产品页: http://localhost:3000
# 后台: http://localhost:3000/admin.html
# 首次启动自动创建 admin/admin123，请立即改密码
```

本地模式用 `data/` 目录下的 JSON 文件做存储，无需外部数据库。

## 部署到 CloudBase

```bash
# 1. 安装 CloudBase CLI
npm install -g @cloudbase/cli

# 2. 登录
tcb login

# 3. 部署云函数
cd cloudfunctions/api
npm install
cd ../..
tcb fn deploy api

# 4. 部署静态网站
tcb hosting deploy public -e <envId>
```

部署前需在 CloudBase 控制台创建以下数据库集合:
- `users` (用户名/密码/角色)
- `files` (文件记录)
- `content` (站点内容, key="site")

手动在 `users` 集合中添加管理员账号（密码需 bcrypt 哈希）。

## 环境变量

| 变量 | server.js 默认值 | 云函数默认值 |
|------|-----------------|-------------|
| PORT | 3000 | - |
| NODE_ENV | - | - |
| SESSION_SECRET | 随机生成 | 随机生成 |
| CORS_ORIGINS | http://localhost:3000 | http://localhost:3000 |

生产环境应设置 `NODE_ENV=production` 和强随机 `SESSION_SECRET`。

## 项目结构

```
file-share-app/
├── server.js              # 本地 Express 服务器
├── package.json           # 依赖 (express, multer, bcryptjs, express-rate-limit)
├── public/
│   ├── index.html         # 产品展示页
│   └── admin.html         # 后台管理页
├── cloudfunctions/api/
│   ├── index.js           # 云函数 (完整 CRUD, DB 存储)
│   └── package.json       # 云函数依赖
├── uploads/               # 本地文件存储 (.gitkeep)
├── data/                  # 本地 JSON 数据库 (gitignore)
└── cloudbaserc.json       # CloudBase 配置
```

## API 路由

所有路由挂载在 `/api/` 下:

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | /api/health | 公开 | 健康检查 |
| POST | /api/login | 公开 | 登录 (15分钟限10次) |
| POST | /api/logout | 登录 | 登出 |
| GET | /api/session | 公开 | 当前会话状态 |
| GET | /api/content | 公开 | 获取站点内容 |
| PUT | /api/content | 管理员 | 更新站点内容 |
| GET | /api/files | 登录 | 文件列表 |
| GET | /api/files/:name | 登录 | 下载文件 |
| POST | /api/files | 管理员 | 上传文件 |
| DELETE | /api/files/:name | 管理员 | 删除文件 |
| GET | /api/users | 管理员 | 用户列表 |
| POST | /api/users | 管理员 | 创建用户 |
| DELETE | /api/users/:username | 管理员 | 删除用户 |
| PUT | /api/users/:username/password | 管理员 | 重置用户密码 |
| PUT | /api/password | 登录 | 修改自己密码 |

## 安全

- 密码使用 bcryptjs 哈希存储 (salt rounds=10)
- 登录接口有频率限制 (15分钟/10次)
- CORS 白名单模式 (CORS_ORIGINS 环境变量)
- 文件下载/删除有路径穿越防护
- Session cookie 设 httpOnly + sameSite
