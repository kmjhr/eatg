# 一咕（EATG）· 手机安装与部署指南

> 目标：把纯前端 PWA 部署上线，手机任何网络都能用，并可打包成安卓 APK。
> 数据仅存手机浏览器本地（IndexedDB），与部署方式无关。

---

## 一、部署到 GitHub Pages（方案 B）

### 1. 推送代码（已完成）

代码已在 `develop` 分支推送到 GitHub：`https://github.com/kmjhr/eatg`。
后续每次改代码后的推送流程：

```bash
cd D:\codex\codex-data\GZ\app
git add -A
git commit -m "改动说明"
git push origin develop
```

### 2. 开启 GitHub Pages（一次设置，约 30 秒）

1. 浏览器打开 `https://github.com/kmjhr/eatg`（需登录）
2. 顶部菜单 **Settings**
3. 左侧 **Pages**
4. **Build and deployment** → Source 选 **Deploy from a branch**
5. Branch 选 **develop**，目录选 **/（root）**，点 **Save**
6. 等待 1～2 分钟，页面顶部出现绿色提示，站点地址为：

```
https://kmjhr.github.io/eatg/
```

### 3. 验证

- 电脑浏览器打开上面的网址，能看到 App 首页即部署成功
- 按 `F12` → Application → Manifest，无红色报错即 PWA 配置正常
- 手机浏览器（Chrome / Edge / 夸克等）打开网址 → 菜单「添加到主屏幕」→ 桌面出现「一咕」图标，独立窗口打开，支持离线

> 提示：更新代码后手机若仍显示旧版，关闭 App 重新打开，或在浏览器设置里清除该站点缓存；Service Worker 会按 `v=` 版本号自动换新。

---

## 二、打包安卓 APK（PWABuilder，无需本机工具链）

### 1. 打包

1. 确认上面的网址能正常打开
2. 访问微软 PWABuilder：`https://www.pwabuilder.com`
3. 首页输入框粘贴 `https://kmjhr.github.io/eatg/`，点 **Start**
4. 自动检测 PWA（manifest / Service Worker / 图标），显示评分与建议（一般可直接打包，提示项可忽略）
5. 点 **Package for Android** → 打包完成后下载 APK

### 2. 签名（关键步骤）

PWABuilder 默认提供**测试签名**，可直接安装体验；若要长期自用建议生成自己的签名：

- 方式一（简单）：直接用 PWABuilder 的默认签名下载 APK 安装
- 方式二（正式）：在 PWABuilder 页面上传自己的 `.keystore` 签名文件（可用 Android Studio 或 `keytool` 生成）

### 3. 安装到手机

1. 把 APK 传到手机（微信/网盘/USB）
2. 安卓设置里允许「安装未知来源应用」
3. 点击 APK 安装，桌面出现「一咕」图标（TWA 壳，独立窗口，离线可用）

> 注意：TWA 安装后数据同样存在手机本地；卸载 APK 会清空数据，重要数据先在「数据管理 → 备份」导出。

---

## 三、iPhone 用户替代方案

iPhone 无法安装 APK，直接用 PWA：

1. Safari 打开 `https://kmjhr.github.io/eatg/`
2. 点分享按钮 → **添加到主屏幕**
3. 桌面出现图标，独立窗口打开，离线可用

---

## 四、国内访问加速（可选）

GitHub Pages 在国内访问速度一般，自用通常够用；若明显卡顿，可二选一：

- **Cloudflare Pages / Netlify / Vercel**：免费，把仓库导入即可自动构建部署，自带 HTTPS
- **国内对象存储静态托管**（腾讯云 COS / 阿里云 OSS）：需实名认证，费用极低，国内访问最快；配置静态网站托管后把 `app` 目录内容上传即可

## 五、常见问题

| 问题 | 处理 |
|------|------|
| 手机打开白屏 | 网络问题或缓存旧版；用无痕模式打开验证，或清站点缓存 |
| 添加到主屏幕没有图标 | 确认网址是 HTTPS、manifest 正常（F12 → Application → Manifest） |
| APK 安装提示「解析包错误」 | 重新下载完整 APK；确认手机系统 Android 8+ |
| 想要更新 APK | 重新部署代码后，再跑一次 PWABuilder 打包，版本号可在 manifest.json 中调整 |
