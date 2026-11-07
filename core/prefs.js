const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'gui-prefs.json');

// 纯界面状态：引导是否完成、字号、主题。业务配置一律在 config.txt，别加到这里。
const DEFAULTS = {
    onboarded: false,
    font: 'normal',
    theme: 'auto'
};

let fileOverride = null;
function useFile(p) { fileOverride = p; }
function targetFile() { return fileOverride || FILE; }

function getPrefs() {
    try {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(targetFile(), 'utf8')) };
    } catch {
        return { ...DEFAULTS };
    }
}

function setPrefs(patch = {}) {
    const next = { ...getPrefs(), ...patch };
    fs.mkdirSync(path.dirname(targetFile()), { recursive: true });
    fs.writeFileSync(targetFile(), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

// 整体替换（迁移场景用）：与 setPrefs 的合并语义不同，未给出的键会被移除
function replacePrefs(data) {
    fs.mkdirSync(path.dirname(targetFile()), { recursive: true });
    fs.writeFileSync(targetFile(), JSON.stringify(data, null, 2), 'utf8');
    return data;
}

module.exports = { getPrefs, setPrefs, replacePrefs, DEFAULTS, FILE, useFile };
