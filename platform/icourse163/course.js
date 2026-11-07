// 页面结构探测：换新课程时先跑一次，确认页面结构与预期一致
async function snapshot(page) {
    return page.evaluate(() => {
        const cls = (el) => (el && el.className && String(el.className)) || '';
        const chapters = Array.from(document.querySelectorAll('.m-learnChapterNormal'));
        return {
            chapterCount: chapters.length,
            chapterClasses: chapters.map(c => cls(c)).slice(0, 3),
            lsiconCount: document.querySelectorAll('.f-icon.lsicon[data-cid]').length,
            learnedCount: document.querySelectorAll('.f-icon.lsicon.learned').length,
            lessonCount: document.querySelectorAll('.u-learnLesson').length,
            perChapter: chapters.map(ch => ({
                cls: cls(ch),
                lessons: ch.querySelectorAll('.u-learnLesson').length,
                icons: ch.querySelectorAll('.f-icon.lsicon[data-cid]').length,
                title: ((ch.querySelector('.titleBox') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)
            }))
        };
    });
}

// 展开所有尚未展开的章节。
// 已展开的章节内部已有任务点节点，必须跳过——重复点击标题会把章节收起，并让 learned 状态丢失
async function ensureChaptersExpanded(page, log) {
    const total = await page.locator('.m-learnChapterNormal').count();
    let clicked = 0;
    for (let i = 0; i < total; i++) {
        const ch = page.locator('.m-learnChapterNormal').nth(i);
        const icons = await ch.locator('.f-icon.lsicon[data-cid]').count();
        if (icons > 0) continue;
        const tb = ch.locator('.titleBox').first();
        if (await tb.count() === 0) continue;
        await tb.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await tb.click({ timeout: 5000 }).catch(() => {});
        clicked++;
        await page.waitForTimeout(1200);
    }
    if (clicked > 0) log(`   📂 展开 ${clicked} 个折叠章节`);
}

async function probeCourse(page, course, log) {
    log(`🔍 探测课程 ${course.courseKey} (tid=${course.termId})`);
    const url = `${course.url}#/learn/content`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    const before = await snapshot(page);
    log(`📊 展开前：章节 ${before.chapterCount}，任务点 ${before.lsiconCount}，已完成 ${before.learnedCount}`);
    log(`   章节 class: ${JSON.stringify(before.chapterClasses)}`);

    await ensureChaptersExpanded(page, log);
    await page.waitForTimeout(3000);

    const after = await snapshot(page);
    log(`📊 展开后：章节 ${after.chapterCount}，任务点 ${after.lsiconCount}，已完成 ${after.learnedCount}`);

    const detail = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.f-icon.lsicon[data-cid]')).map(el => ({
            cid: el.getAttribute('data-cid'),
            type: ((el.querySelector('.tag') || {}).innerText || '').trim(),
            learned: el.classList.contains('learned'),
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50)
        }));
    });

    log('📋 任务点清单：');
    detail.forEach((t, i) => {
        log(`   ${String(i + 1).padStart(2)}. [${t.learned ? '✓' : ' '}] ${t.type.padEnd(3, '　')} cid=${t.cid}  ${t.text}`);
    });

    const byType = {};
    detail.forEach(t => { byType[t.type] = (byType[t.type] || 0) + 1; });
    log(`📈 类型统计：${JSON.stringify(byType)}`);

    return detail;
}

module.exports = { probeCourse, ensureChaptersExpanded };
