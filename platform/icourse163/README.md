# platform/icourse163

中国大学 MOOC（icourse163.org）平台的实现，由图形界面或命令行入口通过 `run(options)` 调用。

## 模块

| 文件 | 职责 |
|---|---|
| `index.js` | 模块入口，串起登录 → 逐课程学习，负责日志落盘 |
| `config.js` | 配置读取、课程地址解析、目录与节奏参数 |
| `browser.js` | 持久化 profile 启动、反检测注入 |
| `profile.js` | 从本机 Edge 导入登录态 |
| `login.js` | 登录态检测、扫码登录等待 |
| `course.js` | 章节展开、页面结构探测 |
| `video.js` | 播放器控制、进度轮询、卡住恢复 |
| `learn.js` | 任务点调度主循环、完成核对 |
| `quiz.js` | 章节测验：DeepSeek → 题库 → 搜索 → 模型 → 交卷，交卷前走 confirm 闸门 |

## 调用方式

图形界面在「首页」点「一键完成」后，由 `core/cli-options.js` 构造 `RunOptions`，再调用本模块的 `run(options)`；`ctx` 由 `core/run-context.js` 用 AsyncLocalStorage 注入，`control` 由 GUI 侧提供。

```js
const { run } = require('./platform/icourse163');
run({
    courses: [{ url: '<课程URL>', courseKey: '', termId: '' }],
    probe: false, quiz: false, submit: false, noQuiz: false, limit: 0,
    ctx: current(),   // core/run-context.js
    control: null
});
```

命令行兼容写法（高级用法与脚本调用）：

```bash
node start.js icourse163 "<课程URL>"
node start.js icourse163 "<课程URL>" --probe
node start.js icourse163 "<课程URL>" --limit=3
```

使用说明见 [根目录 README](../../README.md)，实现细节见 [原理.md](../../原理.md) 第一部分与第二部分。

## 修改前必读

- 不要直接操作 `<video>`，播放器会锁死，一切走 UI 点击。
- 不要无条件点击所有 `.titleBox`，会把已展开的章节收起并丢失 `learned` 状态。
- 连续操作之间保留 1~2 秒间隔，平台有并发节流。
