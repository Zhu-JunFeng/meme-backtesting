# Production deployment

GitHub Actions 需要以下 `production` secrets：

- `DEPLOY_HOST`：PG/Redis 所在服务器 IP 或域名
- `DEPLOY_USER`：部署用户，推荐专用非 root 用户
- `DEPLOY_PATH`：服务器上的项目目录，例如 `/opt/meme-backtesting`
- `DEPLOY_SSH_KEY`：部署用户私钥
- `DATABASE_URL`：服务器可访问的 PostgreSQL 连接串
- `REDIS_PASSWORD`：远程 Redis 密码

每次 push 到 `main` 会执行测试、构建、上传源码、数据库迁移并重建 API、worker 和 web 容器。

TradingView Advanced Charts 本地授权资源不会随 workflow 上传。若生产环境需要完整图表，请在服务器的项目目录中预置：

```text
apps/web/public/charting_library/
```
