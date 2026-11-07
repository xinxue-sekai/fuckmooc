const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = path.join(os.homedir(), '.fuckmooc');
const ROOT = path.resolve(__dirname, '..');

function paths() {
    return {
        root: ROOT,
        home: HOME_DIR,
        config: path.join(ROOT, 'config.txt'),
        dataDir: path.join(ROOT, 'data'),
        appEdgeProfile: path.join(ROOT, 'data', 'app-edge-profile'),
        appPortFile: path.join(ROOT, 'data', 'app-port.json'),
        guiPrefs: path.join(ROOT, 'data', 'gui-prefs.json'),
        guiStdout: path.join(ROOT, 'data', 'gui-stdout.log'),
        icourseProfile: path.join(HOME_DIR, 'icourse163-profile'),
        trayIcon: path.join(ROOT, 'ui', 'tray.ico')
    };
}

function resolveEdge() {
    if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
    if (process.platform !== 'win32') return 'microsoft-edge';
    const candidates = [
        process.env['PROGRAMFILES(X86)'],
        process.env.PROGRAMFILES,
        process.env.LOCALAPPDATA
    ].filter(Boolean).map(base => path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    return candidates.find(p => fs.existsSync(p)) || 'msedge.exe';
}

// --app 必须配一个独立的 --user-data-dir，否则 Edge 会退化成普通标签页。
// 两个 Edge 实例各用各的目录，互不干扰：app 窗口、课程浏览器。
function launchAppWindow(url, opts = {}) {
    const { spawn } = require('child_process');
    const p = paths();
    const profile = opts.profileDir || p.appEdgeProfile;
    fs.mkdirSync(profile, { recursive: true });
    const args = [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        '--window-size=1280,840',
        '--no-first-run',
        '--no-default-browser-check'
    ];
    const child = spawn(resolveEdge(), args, { stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    return child;
}

function focusWindow(url, opts = {}) {
    return launchAppWindow(url, opts);
}

// 托盘在二期接入 systray2；装不上就返回 null，服务继续常驻、重复双击仍能唤回。
function showTray(handlers = {}) {
    try {
        const SysTray = require('systray2').default || require('systray2');
        const tray = new SysTray({
            menu: {
                icon: paths().trayIcon,
                title: 'fuckmooc',
                tooltip: 'fuckmooc · 网课助手',
                items: [
                    { title: '显示主窗口', tooltip: '显示主窗口', enabled: true },
                    { title: '暂停 / 继续', tooltip: '暂停 / 继续', enabled: true },
                    { title: '停止', tooltip: '停止', enabled: true },
                    { title: '退出', tooltip: '退出', enabled: true }
                ]
            },
            debug: false,
            copyDir: true
        });
        tray.onClick(action => {
            const idx = Number(action.seq_id);
            const fn = [handlers.show, handlers.togglePause, handlers.stop, handlers.quit][idx];
            if (typeof fn === 'function') fn();
        });
        return tray;
    } catch {
        return null;
    }
}

// 脚本自己的浏览器 profile 里如果混进了本机浏览器的扩展配置，
// Edge 会按清单去商店重新安装并弹出欢迎页。这里把这类文件改名备份，
// 只保留登录数据；需要回退时把 .bak 改回原名即可。
function sanitizeProfile(dir) {
    const def = path.join(dir, 'Default');
    let cleaned = false;
    const stash = (target) => {
        const bak = `${target}.bak`;
        try { fs.rmSync(bak, { recursive: true, force: true }); } catch {}
        try { fs.renameSync(target, bak); cleaned = true; } catch {}
    };
    for (const name of ['Preferences', 'Secure Preferences']) {
        const file = path.join(def, name);
        try {
            if (fs.readFileSync(file, 'utf8').includes('"extensions"')) stash(file);
        } catch {}
    }
    const extDir = path.join(def, 'Extensions');
    if (fs.existsSync(extDir)) stash(extDir);
    return cleaned;
}

module.exports = { paths, resolveEdge, launchAppWindow, focusWindow, showTray, sanitizeProfile, HOME_DIR };
