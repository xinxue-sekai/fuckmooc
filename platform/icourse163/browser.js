const { chromium } = require('playwright');
const { PROFILE_DIR } = require('./config');

// 使用持久化 profile：登录态（cookie/localStorage）保存在本地，扫码一次后可长期复用
async function launchBrowser() {
    let context;
    try {
        context = await chromium.launchPersistentContext(PROFILE_DIR, {
            headless: false,
            channel: 'msedge',
            slowMo: 60,
            viewport: null,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--mute-audio',
                '--no-first-run',
                '--no-default-browser-check'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });
    } catch (e) {
        if (/closed|in use|另一个会话|其他会话/i.test(e.message)) {
            throw new Error('浏览器 profile 正被占用，请先关闭之前打开的自动化浏览器窗口再运行');
        }
        throw e;
    }

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        window.chrome = { runtime: {} };
    });

    const page = context.pages()[0] || await context.newPage();
    return { context, page };
}

// SPA 内切到指定 hash 视图，比 page.goto 更轻，不会整页重载
async function gotoHash(page, hash) {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await page.waitForTimeout(1500);
}

module.exports = { launchBrowser, gotoHash };
