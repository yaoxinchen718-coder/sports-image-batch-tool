# 体育人物高清批量下图工具

这是一个可本地运行、也可部署到线上测试的网页工具。它适合按照中文人物名、球队名、运动类型查找体育人物高清图片，并支持二次筛选和批量下载。

## 当前能力

- 支持中文人名、人物描述、球队名搜索
- 支持足球、篮球、棒球快速筛选
- 默认筛选长边 2048px 以上图片
- 支持单人 / 多人筛选
- 支持头像 / 半身 / 比赛照高级筛选
- 支持浏览器图像识别增强判断
- 支持勾选多张图片并打包下载 ZIP
- 当前图片来源为 Wikimedia Commons，人物线索来自 Wikidata

## 本地启动

```bash
node server.js
```

打开：

```text
http://localhost:3000
```

## Render 部署

1. 把本目录推送到 GitHub 仓库。
2. 打开 Render，创建 `New Web Service`。
3. 选择这个 GitHub 仓库。
4. `Build Command` 留空。
5. `Start Command` 填：

```bash
node server.js
```

6. 部署完成后，Render 会生成一个公网 HTTPS 测试地址。

项目已包含 `render.yaml`，Render 也可以自动识别配置。

## Railway 部署

1. 把本目录推送到 GitHub 仓库。
2. 打开 Railway，选择 `Deploy from GitHub repo`。
3. 选择这个仓库。
4. 启动命令使用：

```bash
node server.js
```

项目已包含 `railway.json`，Railway 可以自动读取部署配置。

## 普通服务器部署

在服务器安装 Node.js 20 或更高版本，然后上传项目目录。

```bash
node server.js
```

如果需要后台常驻，推荐用 PM2：

```bash
npm install -g pm2
pm2 start server.js --name sports-image-batch-tool
pm2 save
```

然后用 Nginx 把域名反向代理到：

```text
http://127.0.0.1:3000
```

## 使用建议

- 最稳的搜索方式是 `中文人名 + 球队名`
- 如果结果偏少，先只搜人物名，再把球队名留空
- 如果想更严格，可以把最小长边切到 2560、3000 或 3840
- 图像识别增强依赖浏览器能力，不支持时会自动退回文字判断
