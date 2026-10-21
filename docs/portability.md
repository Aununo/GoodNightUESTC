# 平台与数据目录

## 支持范围

项目使用 Node.js 22+，提供 macOS、Windows 和 Linux 的服务定义生成器。Linux 额外提供不依赖图形桌面的服务器模式。平台支持代码及离线测试不等于每台设备均已完成学校登录、定位和真实提交验证。

CI 使用合成数据测试，不访问学校、不读取真实浏览器资料、不提交签到。浏览器二进制、系统运行库、图形登录界面和可用定位提供方需要分别准备。

## 浏览器与登录

支持 `chrome`、`msedge`、`chromium`。通过 `init --browser chromium` 选择 Playwright 管理的浏览器，使用项目依赖对应的 Playwright 命令安装浏览器及系统依赖。

每个账号有独立持久化 profile。普通浏览器中的登录不会自动转移到项目 profile；第一次需要在项目浏览器内完成。不要跨用户或操作系统复制密码库，迁移后应本人重新登录。

浏览器定位模式依赖学校页面提供方，并请求 GCJ-02。固定模式是独立的显式配置选项，不属于定位 API 的自动降级。未知或精度超限的结果会停止任务。

## 数据目录

| 平台 | 默认根目录 |
| --- | --- |
| macOS | `~/Library/Application Support/GoodNight` |
| Windows | `%LOCALAPPDATA%\GoodNight` |
| Linux | `$XDG_STATE_HOME/goodnight`，否则 `~/.local/state/goodnight` |

`GOODNIGHT_HOME` 或 `--data-dir` 可以更换根目录。`default` 直接使用根目录，其他账号位于 `accounts/<id>` 下。私有账号清单、配置、浏览器资料、身份绑定、日志及状态不要放进版本控制。

## 服务模式

- Linux 桌面：默认服务依赖 `graphical-session.target`。
- Linux 服务器：`service install --server` 使用用户 `default.target`，配合 linger 持续运行。
- macOS：生成当前用户的 LaunchAgent。
- Windows：生成当前用户交互登录触发的计划任务。

`--all-accounts` 使服务启动统一账号调度器。`--write-only` 只生成定义，不运行服务管理命令。安装与移除仅针对该项目的服务定义。

服务记录 Node、项目和数据目录的绝对路径。移动项目或更换解释器后，需要在明确的维护操作中重新生成服务。单账号模式在启动时读取配置；统一多账号模式每轮重读配置，源码本身不热更新。

服务器必须开机联网。桌面环境的休眠、窗口会话或通知权限也可能影响任务；运行器不会自动唤醒主机。每个账号的真实学校结果应单独验证并保留在私有状态目录。
