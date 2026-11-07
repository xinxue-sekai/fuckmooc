// 本项目的浏览器实例：命令行里带我们的 user-data-dir 标记
// （data/app-edge-profile、~/.fuckmooc/icourse163-profile），不算「用户的 Edge 在运行」
const SELF_PROFILE_MARKS = ['app-edge-profile', 'icourse163-profile', '.fuckmooc'];

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { sanitizeProfile } = require('../../core/host');

// 用户日常使用的 Edge 数据目录
const EDGE_USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');

function isEdgeRunning() {
    // tasklist 按映像名过滤会把 fuckmooc 自己的 Edge 窗口也算进去，
    // GUI 开着时恒为 true，免扫码导入就永远走不通；改查命令行并排除自己的实例
    try {
        const out = execSync(
            'powershell.exe -NoProfile -Command ' +
            '"Get-CimInstance Win32_Process -Filter \\"name=\'msedge.exe\'\\" | ' +
            'ForEach-Object { $_.CommandLine } | Out-String"',
            { encoding: 'utf8', windowsHide: true, timeout: 10000 }
        );
        const lines = out.split('\n').filter(l => /msedge\.exe/i.test(l));
        if (lines.length === 0) return false;
        // 存在一条不含自己 user-data-dir 标记的实例 → 用户的 Edge 在运行
        return lines.some(line =>
            !SELF_PROFILE_MARKS.some(mark => line.toLowerCase().includes(mark)));
    } catch {
        // 命令行查询失败（如 PowerShell 被策略拦截）：回退按映像名判断
        try {
            const tl = execSync('tasklist /FI "IMAGENAME eq msedge.exe" /NH', {
                encoding: 'latin1', windowsHide: true, timeout: 8000
            });
            return /msedge\.exe/i.test(tl);
        } catch {
            return false;
        }
    }
}

function hasCookies(profileDir) {
    return fs.existsSync(path.join(profileDir, 'Default', 'Network', 'Cookies'));
}

function copyFile(rel, profileDir) {
    const src = path.join(EDGE_USER_DATA, rel);
    const dst = path.join(profileDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

// 把本机 Edge 的登录凭据搬进脚本自己的 profile，省掉重新扫码。
// 只搬 Cookies 与解密密钥；Preferences 里带着原浏览器的扩展清单，
// 复制过去会让新 profile 去商店重新安装那些扩展并弹出欢迎页，所以不搬。
// 浏览器运行时这些文件被占用，必须先完全退出 Edge。
function importFromEdge(profileDir, log) {
    if (!fs.existsSync(EDGE_USER_DATA)) {
        return { ok: false, reason: '没找到 Edge 的用户数据目录' };
    }
    if (isEdgeRunning()) {
        return { ok: false, reason: 'Edge 正在运行，登录数据被占用' };
    }
    try {
        // Local State 里放着凭据解密的密钥，缺了它 cookie 读不出来
        copyFile('Local State', profileDir);
        copyFile(path.join('Default', 'Network', 'Cookies'), profileDir);
        log('📥 已导入本机 Edge 的登录数据，正在验证...');
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: `复制失败: ${e.message}` };
    }
}

// 启动前调用：脚本 profile 还没有登录态时，尝试从用户的 Edge 搬一次
function prepareProfile(profileDir, log) {
    if (sanitizeProfile(profileDir)) {
        log('🧹 已清掉脚本 profile 里继承的浏览器扩展配置，不会安装或改动你的插件');
    }
    if (hasCookies(profileDir)) {
        return { imported: false, reason: 'existing' };
    }
    const result = importFromEdge(profileDir, log);
    if (!result.ok) {
        if (result.reason.includes('正在运行')) {
            log('💡 想免扫码的话：先把 Edge 完全退出，再运行一次本脚本，脚本会用你的登录状态');
        } else {
            log(`💡 没能复用本机登录状态（${result.reason}），稍后扫码登录一次即可`);
        }
    }
    return { imported: result.ok, reason: result.reason };
}

module.exports = { prepareProfile, importFromEdge, isEdgeRunning, hasCookies, EDGE_USER_DATA };
