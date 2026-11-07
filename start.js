const { ensureEnvProxy } = require('./core/runtime');
const { parseArgs } = require('./core/cli-options');
const { runWithContext, noopCtx } = require('./core/run-context');

// Node 的 fetch 默认不读 HTTP_PROXY，在有系统代理的机器上会连不上题库之类的接口。
// 检测到代理变量时统一走 core/runtime：22+ 设 NODE_USE_ENV_PROXY 即可，老版本重启进程。
ensureEnvProxy();

// argv 只在 core/cli-options.js 解析
const parsed = parseArgs();

if (!parsed.target) {
    if (parsed.first) {
        console.error('用法：');
        console.error('  node start.js icourse163 <课程URL> [--probe]     # 中国大学 MOOC');
        process.exit(1);
    }
    // F4：三层数字菜单已退役，图形界面从 start.bat 进入
    console.log('请双击 start.bat 打开图形界面');
    process.exit(0);
} else if (parsed.target === 'icourse163') {
    runWithContext(noopCtx, () => require('./platform/icourse163').run());
}
