# 部署到 Render（手机/电脑任何地方都能访问 · 链接永久不变）

> 目标：把 `kc-sync` 发布成一个公网网址，保管员手机、你自己电脑，无论在不在同一网络，打开同一网址即可共用同一份账本、实时同步。

---

## 前置条件
- 一个 **GitHub 账号**（免费）。Render 通过 GitHub 拉代码，我无法替你登录，所以这部分要你自己点几下。
- 本目录已准备好可直接部署：`server.js`（后端）、`public/`（前端）、`render.yaml`（部署配置）、`package.json`。

---

## 步骤一：把代码推到 GitHub

在自己电脑上操作（已在本机初始化好 Git，直接推送即可）：

1. 打开 https://github.com → 右上角 **New repository** → 仓库名随便取（如 `vet-inventory-sync`）→ 选 **Public** → 不要勾选 README → 点 Create。
2. 创建后页面会显示仓库地址，形如 `https://github.com/你的用户名/vet-inventory-sync.git`。
3. 在本机 `kc-sync` 目录里执行（把下面地址换成你自己的）：

```bash
cd C:\Users\Administrator\WorkBuddy\kc-sync
git remote add origin https://github.com/你的用户名/vet-inventory-sync.git
git branch -M main
git push -u origin main
```

> 如果提示要登录，按提示用浏览器授权 GitHub 一次即可。

---

## 步骤二：用 Render 一键拉起

1. 打开 https://render.com → 用 **GitHub 登录**（Sign up / Log in with GitHub）。
2. 登录后点 **New +** → **Blueprint**（蓝图的图标）→ 授权并选中刚才的仓库 → 点 **Connect**。
3. Render 会自动读取 `render.yaml`，显示一个服务配置，直接点 **Apply / Deploy**。
4. 等 1~2 分钟构建完成，Render 会分配一个固定网址，形如：
   `https://vet-inventory-sync-xxxx.onrender.com`
   **这个网址永久不变**，把它发给保管员、自己在电脑上也用这个，即可。

---

## 步骤三（强烈建议）：加一道访问口令

账本现在谁拿到网址都能改。建议加口令：
1. 在 Render 控制台进入该服务 → **Environment** → **Add Environment Variable**。
2. 新增 `API_TOKEN` = 一串你自己定的密码（如 `vet2026abc`）。
3. Save Changes → 服务会自动重启生效。
4. 之后任何人打开网址，会被提示输入口令才能用（前端会在首次使用时要求填写，存在本机）。

---

## 几点说明
- **免费实例会休眠**：免费版空闲约 15 分钟后自动休眠，下次打开要等 ~30~50 秒唤醒，属正常。
- **账本持久化**：已配置 1GB 持久盘（挂载到 `/data`），重启/休眠都不会丢账本；盘按量计费，约 < $0.25/月。若不想花这钱，也可删掉 `render.yaml` 里的 `disks` 段，但那样重启会清空账本——请务必定期在系统「数据备份」导出 JSON。
- **想彻底不要 GitHub**：也可以用 GitLab / Bitbucket 账号替代，Render 同样支持；或把这目录交给任意支持 Node 的云平台（Railway、Fly.io 等），启动命令都是 `node server.js`。

---

## 本地调试（不部署也能跑）
```bash
cd C:\Users\Administrator\WorkBuddy\kc-sync
node server.js
# 浏览器打开 http://localhost:3000
```
