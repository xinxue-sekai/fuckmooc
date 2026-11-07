const { spawnSync } = require('child_process');

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const REEXEC_FLAG = 'FUCKMOOC_PROXY_REEXEC';

function hasProxyEnv() {
    return PROXY_KEYS.some(k => !!process.env[k]);
}

// Node 22 起内置 fetch 支持 NODE_USE_ENV_PROXY，设上就生效，不必重启进程。
// 老版本才沿用原 CLI 的做法：在任何 require / server 启动之前重启自己一次。
function ensureEnvProxy() {
    if (!hasProxyEnv()) return { proxy: false, reexec: false };

    const major = Number((process.versions.node || '0').split('.')[0]);
    if (major >= 22) {
        process.env.NODE_USE_ENV_PROXY = '1';
        return { proxy: true, reexec: false };
    }

    if (process.env[REEXEC_FLAG] === '1') return { proxy: true, reexec: false };

    const r = spawnSync(
        process.execPath,
        ['--use-env-proxy', '--no-warnings', ...process.argv.slice(1)],
        { stdio: 'inherit', env: { ...process.env, [REEXEC_FLAG]: '1' } }
    );
    process.exit(r.status === null ? 1 : r.status);
}

module.exports = { ensureEnvProxy };
