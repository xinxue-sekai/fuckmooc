// 登录态检测与扫码登录。
// 首次运行需要人工扫码，登录态写入 PROFILE_DIR 后可长期复用。

async function isLoggedIn(page) {
    try {
        const byJs = await page.evaluate(() => {
            const u = window.webUser;
            return !!(u && (u.id || u.userId || u.nickName));
        });
        if (byJs) return true;
    } catch {}
    try {
        // 已登录时页面会出现带 userId 的个人中心入口
        return (await page.locator('a[href*="home.htm?userId="]').count()) > 0;
    } catch {
        return false;
    }
}

// 等待用户扫码，最长 timeoutMs
async function waitForLogin(page, log, timeoutMs = 300000) {
    const step = 2000;
    const rounds = Math.floor(timeoutMs / step);
    log('📱 请在弹出的浏览器窗口中完成扫码登录...');
    for (let i = 0; i < rounds; i++) {
        try {
            await page.waitForTimeout(step);
        } catch {
            log('⚠️ 浏览器窗口已关闭，登录中断');
            return false;
        }
        if (await isLoggedIn(page)) {
            log('✅ 登录成功');
            await page.waitForTimeout(2000).catch(() => {});
            return true;
        }
        if (i > 0 && i % 30 === 0) log(`   ⏳ 仍在等待登录 (${(i * step / 1000).toFixed(0)}s)`);
    }
    return false;
}

async function ensureLoggedIn(page, log, timeoutMs = 600000) {
    log('🌐 打开中国大学 MOOC...');
    await page.goto('https://www.icourse163.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.bringToFront().catch(() => {});

    if (await isLoggedIn(page)) {
        log('✅ 已登录（复用本地登录状态，无需扫码）');
        return true;
    }

    log('🔐 未登录，打开登录框...');
    const loginEntry = page.getByText('登录', { exact: true }).first();
    if (await loginEntry.count() > 0) {
        await loginEntry.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(3000);
    }
    await page.bringToFront().catch(() => {});

    const ok = await waitForLogin(page, log, timeoutMs);
    if (!ok) {
        log('❌ 登录超时');
        return false;
    }

    // 登录后回到首页，确保后续跳转不受弹窗影响
    await page.goto('https://www.icourse163.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    return true;
}

module.exports = { ensureLoggedIn, isLoggedIn };
