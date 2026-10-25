# 槽位账号池与网页会话

本分支以 v1.3.220 为基础，整理当前部署使用的源码。包含账号池、槽位凭据绑定、槽位浏览器登录、远程屏幕控制、ChatGPT Session 导出和现有套餐自动续订管理，以及关闭调度后保持静置的相关修改。

## 账号导入与登录

- 支持 `邮箱---邮箱密码`、四横线或逗号分隔的两列微软邮箱凭据。
- 支持邮箱、GPT 密码、TOTP 密钥三列导入。TOTP 可以是原始密钥、otpauth URI 或 `https://2fa.run/2fa/<密钥>`；仅在本地解析密钥。
- 导入和绑定仅保存加密凭据，不启动浏览器或登录。选择槽位后点击登录，在该槽位原有代理、网络和浏览器环境内执行。
- 关闭调度的槽位不执行登录、额度探测、指纹测试、Session 导出或续订查询及修改。

## 网页会话与续订

槽位菜单和详情提供远程屏幕、Session 导出及自动付费续订入口。Session 来自当前槽位已登录网页的 `https://chatgpt.com/api/auth/session`，不会将 Session 内容写入应用日志。

续订功能先读取官网的现有付费套餐状态。关闭代表到期取消，开启代表恢复现有套餐续订，修改后再次核验。打开面板不会自动登录或查询账单。当前实现仍需先在槽位完成网页登录；仅有 API OAuth 令牌时不会自动创建网页 Session。

真实账号的付费开关尚未执行验证；相关取消、恢复、拒绝立即付款和结果核验逻辑通过离线浏览器夹具测试。

## 只读容器的浏览器运行时

`src/lib/oauth/codex-mailbox-runtime.mjs` 支持将运行时部署在槽位可写 home 的 `.local/share/kin-mailbox`，避免向只读根目录安装软件。Docker 使用槽位原用户；KVM 在所选来宾内执行。运行时升级校验 SHA256，并保留浏览器 profiles、cache 和 config。

`scripts/build-mailbox-portable.py` 从 Ubuntu 24.04 amd64 的浏览器构建环境生成压缩包：环境需预装 Python 3.12、`/opt/kin-mailbox/venv` 中的 Playwright 1.64.1、`/opt/kin-mailbox/browsers` 中的 Chromium 及系统依赖。打包脚本收集 ELF 依赖、NSS 动态加载模块与字体，不包含账号或 profile。构建须使用 root，标准输出为 tar.gz 二进制流。

将压缩包保存为控制平面项目目录下 `share/kin-mailbox-runtime/ubuntu24.04-amd64.tar.gz`，同目录创建 `manifest.json`，包含 `version`（`1.64.1`）和 `sha256`。此可搬移包针对 Ubuntu 24.04 amd64/Python 3.12 的槽位；其他环境需匹配构建。压缩包不随源码提交。没有 manifest 时保留原安装流程。

## 已完成的验证

- 51 项后端测试、13 项离线浏览器测试、2 项进程监督测试通过。
- 前端 TypeScript/Vite 构建与浏览器模拟界面测试通过。
- 真实只读 Docker 和 KVM 槽位的 NSS、Chromium 准备通过；HTTPS 访问通过。
- 未登录槽位读取订阅返回 `session_not_authenticated`，面板显示登录入口。

相关测试入口：`test/unit/codex-mailbox-runtime.test.mjs`、`codex-subscription.test.mjs`、`codex-mailbox.test.mjs`、`codex-credential-pool.test.mjs`、`slot-idle.test.mjs`，以及 `test/codex-mailbox-browser-test.py`、`test/codex-mailbox-supervisor-test.py` 和 `test/slot-menu-smoke.py`。
