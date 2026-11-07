# AGENTS.md

## 项目概览

- 项目名 `fuckmooc`，网课自动化工具，聚焦中国大学 MOOC，主入口是图形界面。
- 运行环境：Node.js **>= 22**，由 Playwright 驱动本机 Microsoft Edge（不额外下载浏览器）；界面窗口由 `core/host.js` 用 Edge `--app` 模式拉起。
- 入口分两套，共用同一套业务模块：
  - `gui.js`（双击 `start.bat` 拉起）→ 图形界面：单实例探测 → 事件总线 → 本地 HTTP/SSE → Edge app 窗口
  - `start.js` 是命令行兼容入口：
    - `node start.js icourse163 "<课程URL>"` → `platform/icourse163/`，中国大学 MOOC 实现
- 不带参数运行 `node start.js` 只输出提示；界面由 `start.bat` / `node gui.js` 启动，不再依赖数字选择流程。
- 目录分层：`core/` 放业务共用能力与 GUI 基础设施，`platform/icourse163/` 管平台实现，`ui/` 放界面静态资源，互不依赖。
- 配置模板 `config.txt.expample`，运行时配置 `config.txt`（不入库）；登录态统一放在 `~/.fuckmooc/icourse163-profile`，答题模型走 OpenAI 兼容 API（`LLM_*` 键，「设置 → 配置模型」浮窗配置），界面状态在 `data/gui-prefs.json`。

## 常用命令

```bash
npm install
npm test          # 冒烟测试 + 文档一致性检查（test/doccheck.js），不需要浏览器，几秒跑完
node gui.js       # 直接起图形界面（start.bat 的实际入口）

# 中国大学 MOOC（命令行兼容）
node start.js icourse163 "https://www.icourse163.org/learn/XXXX-1234567?tid=8901234"
node start.js icourse163 "<课程URL>" --probe      # 只扫描结构，不操作
node start.js icourse163 "<课程URL>" --limit=3    # 只处理前 3 个任务点
node start.js icourse163 "<课程URL>" --quiz       # 只做测验，演练不提交
node start.js icourse163 "<课程URL>" --quiz --submit  # 做测验并提交
```

## 平台要点（改动前先看）

中国大学 MOOC 前端是 RegularJS 单页应用 + hash 路由；扫码一次，登录态存 `~/.fuckmooc/icourse163-profile`。视频必须走播放器 UI；完成判定看服务端 `learned` 类；测验只有 3 次提交，取最高分。

改 icourse163 部分时特别注意：

- 点击章节标题会切换展开/收起，**不能无条件点击所有 `.titleBox`**，否则 `learned` 状态全部丢失。
- 测验的**选项顺序每次进入都会随机重排**，任何答案都必须还原成选项文字再匹配，绝不能直接用字母。
- 交卷动作统一收敛到 `submitQuiz()`，GUI 下由 `ctx.confirm('submit')` 弹窗确认，不要在别处另开确认。

## 改动要求

- 只需完成用户要求的功能的最小化更改，无需做过多测试和防御性编程
- 保持现有 CommonJS 风格和简洁的 JavaScript 写法。
- 优先做小范围修改，不随意重构无关代码。
- 修改页面交互逻辑时，注意等待、重试和异常处理。
- 若行为、配置或使用方式发生变化，同步更新 `README.md`、`原理.md`、`使用说明.txt`、`CHANGELOG.md`、`AGENTS.md`、`platform/icourse163/README.md` 六份文档。
- 改完六份文档后 grep 一遍旧描述关键词（数字选择界面、首次弹窗引导、旧 Node 版本下限、项目内登录态路径），确认零命中，再跑 `npm test`。
- **改完必须跑 `npm test`**。它包含一块文档一致性检查（`test/doccheck.js`），会拦住三类走神：
  - `core/` 或 `platform/icourse163/` 下新增的模块没写进 README 目录结构
  - `config.txt.expample` 里新增的配置键没写进 README 配置表
  - `package.json` / `CHANGELOG` 最新条目 / 最新 git tag 三者版本不一致

  检查不过就补文档，别硬提交。
- 改动完某一个功能或者修复完某一个bug，输出一个简洁的english commit message（使用gitmoji，例如🐛 navigate directly to course center on retries）

## 文档约定

- `README.md` 面向使用者，按「电脑小白照着做」的标准写：每一步都要说明在哪操作、会看到什么、失败了怎么办。
- `原理.md` 面向维护者，写技术实现、页面结构、踩过的坑。
- 面向用户的输出不要写内部术语，命令和路径要可直接复制。
- 界面名称统一写 `fuckmooc`，界面文案不使用 emoji。

## 安全

- 不要提交账号、密码、Cookie、截图或用户运行数据。
- 不要覆盖用户的 `config.txt`、`data/` 与 `~/.fuckmooc/` 内容。

## No Negative Echo

- 生成最终产物及其包装（标题、文件名、正文、注释、commit、PR、交付说明）时，只写最终采用的状态，并假设读者没看过本次会话。
- 被否决的方案、中间尝试和措辞纠正只作控制信息，不进入命名和叙述。
- 「不要提 X」不等于写「无 X」，应从正向目标重写，不要在被否文案上改词。
- 过程信息只在两种情况下保留：省略会造成不准确、不安全、误导或缺失兼容性信息；或它是任务开始时已提交或经用户确认状态的真实变化，且当前交付面需要解释。
- 真实的基线变化、已执行的外部操作，以及必要的技术名称、诊断、测试和快照照常保留。
- 与本任务无关的改动不写入 commit、PR 或交付说明。
- 写完后通读所有用户可见内容及其包装（含文件名、元数据、hook 改写），不要另加「已清理」类声明。
