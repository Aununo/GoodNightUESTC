# GoodNightUESTC

基于 [beichenO2/GoodNight](https://github.com/beichenO2/GoodNight) 的“晚安成电”宿舍签到工具，使用 Node.js 和 Playwright，支持 Linux 服务器后台运行。

- 多账号独立保存登录、配置和记录，按北京时间分别调度。
- 签到前检查学校时段与宿舍范围，提交后回读记录确认结果。
- 支持浏览器定位和显式配置的 GCJ-02 固定坐标。
- 支持自动重登；首次登录、验证码和双因子认证由本人完成。
- 请求结果不明时只查询记录，避免重复提交。

需要 Node.js 22+ 和浏览器运行环境。可让 Agent 参照[部署文档](docs/linux-server.md)完成配置；详细命令和排错步骤均在文档中。

[运行原理](docs/architecture.md) · [平台与数据目录](docs/portability.md) · [恢复与排错](docs/resilience.md) · [参与开发](CONTRIBUTING.md)

账号、坐标、登录资料和运行记录保存在本地私有目录，不应提交到公开仓库。固定坐标是配置值，不代表实时测量位置。参见[安全说明](SECURITY.md)。

[English](README.en.md) · [MIT License](LICENSE)
