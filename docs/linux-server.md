# Linux 服务器部署

本分支支持独立账号、浏览器或显式固定位置、宿舍签到及记录回读。所有任务时间使用北京时间；本文账号名、目录和时间都是通用示例，不记录实际部署信息。

## 安装与初始化

准备 Node.js 22+ 和 npm，在项目目录执行：

```bash
npm ci
npx playwright install --with-deps chromium
node bin/goodnight.mjs init --browser chromium --time 22:30
```

`config.server.example.json` 提供服务器配置结构。首次初始化的提交和自动重登开关均关闭。默认数据目录是 `~/.local/state/goodnight`，可用 `GOODNIGHT_HOME` 或 `--data-dir` 选择根目录。

## 远程手动登录

临时图形登录界面需要这些系统工具：

```bash
sudo apt-get install xvfb xauth x11vnc novnc websockify
bash scripts/login-server.sh
```

指定账号时使用 `bash scripts/login-server.sh --account student-b`。同一时间开启一个登录界面；后台调度可以继续处理其他账号。

在本人电脑另开终端，使用自己的 SSH 连接参数转发端口：

```bash
ssh -N -L 127.0.0.1:6081:127.0.0.1:6081 user@your-server
```

打开 `http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale`，本人完成学校统一认证，再进入“晚安成电”。该界面只处理登录，不提交签到；业务认证成功或 30 分钟后关闭。VNC 与网页仅监听本机，端口分别为 5901 和 6081。

如需在 SSH 断开后继续首次登录，可使用临时用户服务；将下面路径替换为自己的项目绝对路径：

```bash
systemd-run --user --collect --unit=goodnight-login --property=RuntimeMaxSec=30min /usr/bin/bash /path/to/GoodNightUESTC/scripts/login-server.sh --account student-b
journalctl --user -u goodnight-login -n 20 --no-pager
```

## 多账号与私有数据

```bash
node bin/goodnight.mjs account add student-b --label '示例账号B' --time 22:35
node bin/goodnight.mjs account list
node bin/goodnight.mjs doctor --account student-b --online
node bin/goodnight.mjs locations --account student-b
node bin/goodnight.mjs check --account student-b
node bin/goodnight.mjs status --all-accounts
```

只添加本人授权的账号。`default` 使用根目录；其他账号使用根目录下的 `accounts/<id>`，内含各自 `config.json`、`profile`、日志及提交记录。新增账号只继承通用运行设置，不继承凭据、固定位置、启用开关或历史记录。

`--data-dir` 指定根目录，`--account` 选择已注册账号。未知 ID 会报错，不回退到其他账号。学校稳定用户 ID 的哈希绑定到账号目录；身份变化或同一身份已注册在另一账号时停止认证。

目录和配置分别使用 700、600 权限。浏览器密码库、Cookie 和身份文件也属于私有运行数据；不要复制进仓库。浏览器密码库本身不能替代主机访问控制。

## 位置与启用

`locations` 只读取学校为当前会话返回的宿舍圈。按该账号的实际返回结果及所需定位方式配置，不复用其他账号的位置。

浏览器定位模式：

```json
{
  "locationProvider": "browser",
  "fixedLocation": null
}
```

固定模式要求 `fixedLocation` 包含三个数值字段：`latitude`、`longitude` 和 `accuracy`；纬度和经度必须使用 GCJ-02，精度不得超过 `maxAccuracyMeters`。程序验证该点是否落在学校实时返回的可用圈内。固定值不是实时测量，文档和示例不提供任何真实宿舍坐标。

保持提交开关关闭，先执行：

```bash
node bin/goodnight.mjs run --account student-b --dry-run
```

预检通过后，在该账号私有 `config.json` 中设置 `submissionsEnabled=true`。真实提交仍受学校时段及配置截止时间约束。提交结果不明时只查询保存记录，不重复 POST。

## 常驻运行

```bash
sudo loginctl enable-linger "$USER"
node bin/goodnight.mjs service install --server --all-accounts
systemctl --user status io.github.beichenO2.goodnight.service --no-pager
```

`--server` 绑定用户 `default.target`；linger 使用户服务在 SSH 退出后保持运行，并可随服务器启动。服务定义保存在 `~/.config/systemd/user/io.github.beichenO2.goodnight.service`。服务器需要开机联网。

统一调度每轮依次处理各账号，约每 30 秒重新读取清单和配置；禁用提交的账号不会自动打开浏览器或访问学校。配置改动在下一轮生效，无需为修改账号时间重启服务。单账号 `daemon` 则在启动时读取配置。

更新源码、Node 或项目绝对路径后，需要在合适的维护时段重新装载程序或服务；不要把配置热更新当作源码热更新。

## 自动重新登录

按账号设置 `autoRelogin=true`，只在业务接口明确要求登录时尝试恢复。程序优先复用学校 SSO 和浏览器自动填充；需要密码时可读取同一资料目录内、精确匹配学校域名的唯一已保存条目，再执行一次正常登录。随后访问应用入口 `/daily-checkin/checkLogin`，以业务接口验证是否恢复。

Linux 密码库后备读取目前仅兼容实现所支持的 Chromium v10 格式。凭据仅在内存中使用，不另存明文 JSON 或写入日志。不支持的加密格式、多个学校条目、未知页面、验证码或双因子认证需要本人处理。

失败或不确定的登录尝试不会反复提交密码；完成更新的手动登录后解除恢复阻塞。成功恢复后有 10 分钟间隔。业务会话、SSO 和“信任浏览器”记录的有效期均由学校控制。

## 状态与移除

```bash
node bin/goodnight.mjs status --all-accounts
node bin/goodnight.mjs check --all-accounts
node bin/goodnight.mjs service remove
```

`status` 读取本地状态，`check` 查询学校记录。移除服务保留配置及浏览器资料。回到单账号调度可在明确需要时安装不带 `--all-accounts` 的服务。不要删除提交标记来盲目重复请求，也不要为了排错清空正式浏览器资料。
