// 播放器控制。
// 要点：icourse163 的播放器对直接操作 <video> 很敏感，优先走真实 UI 点击。
const { checkpoint, current } = require('../../core/run-context');

async function getVideoState(page) {
    return page.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const d = v.duration;
        return {
            t: v.currentTime,
            d: Number.isFinite(d) ? d : 0,
            ended: v.ended,
            paused: v.paused,
            rate: v.playbackRate,
            ready: v.readyState
        };
    }).catch(() => null);
}

async function clickIfExists(page, selectors) {
    for (const sel of selectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            await loc.click({ timeout: 5000 }).catch(() => {});
            return sel;
        }
    }
    return null;
}

// 通过倍速菜单设置播放速度
async function setPlaybackRate(page, rate, log) {
    const btn = page.locator('.j-ratebtn').first();
    if (await btn.count() === 0) return false;

    await btn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);

    const items = page.locator('.m-popover-rate li');
    const n = await items.count();
    for (let i = 0; i < n; i++) {
        const text = (await items.nth(i).innerText().catch(() => '')).trim();
        const num = text.replace(/[^\d.]/g, '');
        if (num && Number(num) === Number(rate)) {
            await items.nth(i).click({ timeout: 5000 }).catch(() => {});
            log(`   ⏩ 倍速设为 ${text}`);
            return true;
        }
    }
    // 没找到目标档位，关闭菜单
    await page.keyboard.press('Escape').catch(() => {});
    return false;
}

// 播放当前视频直到结束。返回是否判定为播放完成
async function playVideo(page, log, rate = 2, maxMs = 3 * 60 * 60 * 1000) {
    const started = Date.now();

    // 等播放器就绪（启动段约 50s 连续等待，分点检查停止）
    try {
        await page.locator('video').first().waitFor({ state: 'attached', timeout: 45000 });
    } catch {
        log('   ⚠️ 播放器未出现');
        return false;
    }
    await checkpoint();
    await page.waitForTimeout(3000);
    await checkpoint();

    // 用真实按钮启动播放
    const btn = await clickIfExists(page, ['.j-bigplaybtn', '.j-playbtn']);
    if (btn) log(`   ▶️ 点击播放 (${btn})`);
    await page.waitForTimeout(2000);
    await checkpoint();

    await setPlaybackRate(page, rate, log);

    let lastLog = 0;
    let stallRounds = 0;
    let lastT = -1;

    while (Date.now() - started < maxMs) {
        // 播放中是 2.5s 轮询循环，每轮检查暂停 / 停止
        await checkpoint();
        const st = await getVideoState(page);
        if (!st) {
            log('   ⚠️ 播放器已消失，判定结束');
            return true;
        }
        if (st.ended || (st.d > 0 && st.d - st.t < 2)) {
            log(`   ✅ 播放完成 (${st.t.toFixed(1)}/${st.d.toFixed(1)})`);
            return true;
        }

        const now = Date.now();
        if (now - lastLog > 15000) {
            const pct = st.d > 0 ? ((st.t / st.d) * 100).toFixed(1) : '?';
            log(`   ▶️ ${st.t.toFixed(1)} / ${st.d.toFixed(1)} (${pct}%)  倍速 ${st.rate}`);
            current().emit('progress', {
                scope: 'current', current: st.t, total: st.d,
                percent: Number(pct) || 0, label: '播放视频',
                detail: `${st.t.toFixed(1)} / ${st.d.toFixed(1)}`
            });
            lastLog = now;
        }

        // 卡住检测：进度长时间不动就尝试点一次播放按钮
        if (Math.abs(st.t - lastT) < 0.5) {
            stallRounds++;
            if (stallRounds >= 8) {
                log('   ⚠️ 播放停滞，尝试恢复');
                await clickIfExists(page, ['.j-playbtn', '.j-bigplaybtn']);
                stallRounds = 0;
            }
        } else {
            stallRounds = 0;
        }
        lastT = st.t;

        await page.waitForTimeout(2500);
    }

    log('   ⚠️ 播放超时');
    return false;
}

module.exports = { playVideo };
