// 文档一致性检查：让「改了代码忘了文档」在 npm test 里直接失败
//
// 检查的都是能机械判断的事实，不做语义理解：
//   1. core/ 与 platform 下每个模块，都要在 README 的目录结构里出现
//   2. config.txt.expample 里的每个配置键，都要在 README 的配置表里出现
//   3. package.json 版本、CHANGELOG 最新条目、最新 git tag 三者一致
//
// 语义层面的东西（比如「讨论现在支持了」）没法自动查，但上面这些能挡住大部分偷懒。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

function read(p) {
    try {
        return fs.readFileSync(path.join(ROOT, p), 'utf8');
    } catch {
        return '';
    }
}

const readme = read('README.md');
const sample = read('config.txt.expample');

// 1. 模块清单
function checkModules(dir, label) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const f of fs.readdirSync(abs)) {
        if (!f.endsWith('.js')) continue;
        if (!readme.includes(f)) {
            problems.push(`${label} 的 ${f} 没在 README 目录结构里出现`);
        }
    }
}

checkModules('core', 'core');
checkModules('platform/icourse163', 'platform/icourse163');

// 2. 配置项：模板里的键必须写进 README 配置表（正向），
//    README 配置表里的键必须真实存在于模板（反向，防止文档记了已删的键）
const keys = [...sample.matchAll(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm)].map(m => m[1]);
const uniqueKeys = [...new Set(keys)];
for (const k of uniqueKeys) {
    if (!readme.includes(k)) {
        problems.push(`配置项 ${k} 没在 README 的配置表里出现`);
    }
}
const configSection = readme.split(/^## /m).find(s => s.trim().startsWith('配置')) || '';
const readmeKeys = [...new Set([...configSection.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map(m => m[1]))];
for (const k of readmeKeys) {
    if (!sample.includes(k)) {
        problems.push(`README 配置表里的 ${k} 在 config.txt.expample 里不存在`);
    }
}

// 3. 版本号三处一致
const pkgVersion = JSON.parse(read('package.json')).version;
const changelog = read('CHANGELOG.md');
const changelogVersion = (changelog.match(/^## (\d+\.\d+\.\d+)/m) || [])[1];

if (changelogVersion && changelogVersion !== pkgVersion) {
    problems.push(`package.json 是 ${pkgVersion}，CHANGELOG 最新条目是 ${changelogVersion}`);
}

let tagVersion = '';
try {
    tagVersion = execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().replace(/^v/, '');
} catch {
    // 没有 tag 的仓库跳过这项
}
if (tagVersion && tagVersion !== pkgVersion) {
    problems.push(`package.json 是 ${pkgVersion}，最新 git tag 是 v${tagVersion}（发版前先对齐）`);
}

// 结果
if (problems.length === 0) {
    console.log(`文档检查通过（模块 ${fs.readdirSync(path.join(ROOT, 'core')).filter(f => f.endsWith('.js')).length} 个、配置项 ${uniqueKeys.length} 个、版本 ${pkgVersion}）`);
    process.exit(0);
}

console.error('文档和代码对不上：');
for (const p of problems) console.error(`  - ${p}`);
console.error('\n以上只覆盖能机械检查的部分；使用说明.txt / 原理.md / AGENTS.md 需要自行同步。');
process.exit(1);
