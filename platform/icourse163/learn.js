const config = require('./config');
const { humanDelay } = config;
const progress = require('../../core/progress');
const { playVideo } = require('./video');
const { ensureChaptersExpanded } = require('./course');
const { parseArgs } = require('../../core/cli-options');
const { checkpoint, current } = require('../../core/run-context');

// 不自动处理的任务类型集合；当前为空，讨论和测验都会处理
const SKIP_TYPES = new Set();

// 调试/限量用：只处理前 N 个任务点。GUI 从 opts 传，CLI 从 argv 读；0 视为不限
function resolveLimit(opts) {
    const passed = opts.limit !== undefined ? opts.limit : parseArgs().limit;
    return passed > 0 ? passed : Infinity;
}

async function collectTasks(page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.f-icon.lsicon[data-cid]')).map(el => {
            const ch = el.closest('.m-learnChapterNormal');
            const titleBox = ch && ch.querySelector('.titleBox');
            const chapter = titleBox
                ? (titleBox.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)
                : '';
            return {
                cid: el.getAttribute('data-cid'),
                type: ((el.querySelector('.tag') || {}).innerText || '').trim(),
                learned: el.classList.contains('learned'),
                text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
                chapter: chapter || '未分章'
            };
        })
    );
}

// 界面按章折叠的任务清单与总体进度。CLI 下 ctx.emit 是空操作，不改变任何输出。
function emitTasks(ctx, tasks, course, activeCid) {
    const items = tasks.map(t => ({
        id: t.cid, cid: t.cid, chapter: t.chapter || '未分章',
        type: t.type, title: t.text,
        status: t.learned ? 'done' : (t.cid === activeCid ? 'running' : 'pending')
    }));
    const doneN = tasks.filter(t => t.learned).length;
    ctx.emit('tasks', { items, courseKey: course.courseKey });
    ctx.emit('progress', {
        scope: 'overall', current: doneN, total: tasks.length,
        percent: tasks.length ? Math.round(doneN / tasks.length * 100) : 0,
        label: course.courseKey, detail: `${doneN} / ${tasks.length}`
    });
}

async function openTask(page, cid) {
    const el = page.locator(`.f-icon.lsicon[data-cid="${cid}"]`).first();
    if (await el.count() === 0) return false;
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await humanDelay(page);
    await el.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(4000);
    return true;
}

async function backToList(page) {
    await page.evaluate(() => { window.location.hash = '#/learn/content'; }).catch(() => {});
    await page.waitForTimeout(3500);
}

// 打开任务点并等待页面进入详情视图
async function enterTask(page, task, log) {
    const ok = await openTask(page, task.cid);
    if (!ok) {
        log(`   ⚠️ 未找到任务点 cid=${task.cid}，可能页面已刷新`);
        return false;
    }
    // 详情视图特征：出现播放器容器或富文本正文区
    const entered = await page.evaluate(() => {
        return !!document.querySelector('video')
            || !!document.querySelector('.m-learnunitUI')
            || location.hash.includes('type=detail');
    }).catch(() => false);
    if (!entered) log('   ⚠️ 未进入详情视图');
    return entered;
}

async function handleDocument(page, log, stayMs) {
    log(`   📄 停留 ${Math.round(stayMs / 1000)} 秒以完成阅读判定`);
    const deadline = Date.now() + stayMs;
    while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        // 文档停留是长等待，每轮检查暂停 / 停止
        await checkpoint();
        // 页面被自动连播或跳走时提前结束
        const gone = await page.evaluate(() => !location.hash.includes('type=detail')).catch(() => false);
        if (gone) break;
    }
}

// 页面加载偶发超时（缓存冷启动、网络抖动），重试一次比直接失败划算
async function gotoWithRetry(page, url, log, times = 2) {
    for (let i = 1; i <= times; i++) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            return true;
        } catch (e) {
            if (i === times) throw e;
            log(`   ⚠️ 页面加载超时，重试一次...`);
            await page.waitForTimeout(2000);
        }
    }
    return false;
}

// 讨论区回复：用 Quill 编辑器，填完点「发表回复」
// 短、平、不带私人信息——发在公开讨论区，越像随手一答越安全
const DISCUSSION_PROMPT = `请就下面这个课程讨论话题写一段简短回复，60~100 字，三四句话就够了。

要求：
- 直接谈对话题本身的理解，观点明确
- 不要写个人经历、个人情况、专业背景、身边的事例
- 不要用「首先、其次、最后」这类模板结构
- 不要用「在当今社会」「随着……的发展」「综上所述」这类开头结尾
- 不要出现「作为一名AI」这类词
- 直接输出正文，不要标题、不要引号

话题：`;

async function generateReply(topic, log) {
    const prompt = DISCUSSION_PROMPT + topic;

    // 讨论优先用配置的模型写，它的整段文字比免费池自然。
    // 讨论是低频操作（一场几十条），即使之前答题把模型撞到熔断，这里也该重新给一次机会
    const ds = require('../../core/llm');
    if (config.LLM_API_KEY) {
        if (ds.isDisabled()) {
            ds.reset();
            log('   🔄 答题模型之前被熔断，讨论这里重新启用');
        }
        try {
            const t = await ds.askText(prompt, log, {
                apiKey: config.LLM_API_KEY,
                baseUrl: config.LLM_BASE_URL || undefined,
                model: config.LLM_MODEL || undefined,
                protocol: config.LLM_PROTOCOL || 'openai',
                temperature: 1,
                maxTokens: 300
            });
            if (t && t.length > 40) {
                log('   ✍️ 内容由配置模型生成');
                return t.replace(/^[「"'"]|[」"'"]$/g, '').trim();
            }
        } catch (e) {
            log(`   ⚠️ 配置模型不可用: ${e.message}`);
        }
    }

    try {
        const freeModel = require('../../core/free-model');
        const t = await freeModel.askText(prompt, log);
        if (t && t.length > 40) {
            let text = t.trim();
            // 免费模型对字数要求不敏感，超长就截到最后一个完整句子
            if (text.length > 130) {
                const cut = text.lastIndexOf('。', 130);
                if (cut > 50) text = text.slice(0, cut + 1);
            }
            log(`   ✍️ 配置模型不可用，改用免费模型生成（${text.length} 字）`);
            return text;
        }
    } catch {}

    log('   ⚠️ 两个模型都没生成出内容，这条讨论跳过');
    return '';
}

async function handleDiscussion(page, log) {
    const editor = page.locator('.ql-editor').first();
    if (await editor.count() === 0) {
        log('   ⚠️ 没找到回复输入框，跳过');
        return false;
    }

    // 话题描述在详情区顶部，截一段交给模型，避免把下面几百条回复也带进去
    const topic = await page.evaluate(() => {
        const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
        const body = clean(document.body.innerText);
        const start = Math.max(0, body.indexOf('讨论区'));
        return body.slice(start, start + 600);
    });

    log('   ✍️ 正在生成回复...');
    const text = await generateReply(topic, log);
    if (!text) {
        log('   ⚠️ 生成失败，这条讨论跳过');
        return false;
    }

    await editor.click({ timeout: 8000 }).catch(() => {});
    await editor.type(text, { delay: 12 });
    await page.waitForTimeout(1200);

    const btn = page.getByText('发表回复', { exact: true }).first();
    if (await btn.count() === 0) {
        log('   ⚠️ 没找到「发表回复」按钮，跳过');
        return false;
    }
    await btn.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // 发出去的话编辑框会清空
    const left = await editor.innerText().catch(() => '');
    if (left && left.trim().length > 20) {
        log('   ⚠️ 回复可能没发出去，编辑框里还剩内容');
        return false;
    }

    log(`   ✅ 已发表回复（${text.length} 字）`);
    return true;
}

// 章节里内嵌的课后测验：题目直接铺在详情页，没有「开始」环节，底部就是「提交」
async function handleInlineQuiz(page, log, opts = {}) {
    const { answerAll, submitQuiz, submittedState, countUnchecked } = require('./quiz');

    // 已交过的测验直接跳过：平台标记翻转慢时列表会把它当成没做，重进重答会再烧一次机会
    if ((await submittedState(page)).ok) {
        log('   ⏭ 该测验已提交过，跳过');
        return true;
    }

    const count = await page.evaluate(() => document.querySelectorAll('.m-choiceQuestion').length).catch(() => 0);
    if (count === 0) {
        log('   ⚠️ 没读到题目，跳过');
        return false;
    }
    log(`   测验内嵌在页面里，共 ${count} 题`);

    const outcome = await answerAll(page, log, Date.now() + config.QUIZ_BUDGET_MS);
    if (!outcome || outcome.total === 0) return false;

    // 空题数取「统计值」与「页面真实勾选复核」里更保守的那个（点击可能空转）
    const answered = outcome.results.filter(r => r.answered).length;
    const missed = Math.max(outcome.total - answered, await countUnchecked(page));
    if (missed / outcome.total > config.QUIZ_MAX_MISS_RATIO) {
        // 答案异常，「本场不再提示」缓存立即失效
        current().resetSkipConfirm?.();
        log(`   🛑 ${outcome.total} 题里空了 ${missed} 题，超过上限，不提交`);
        return false;
    }

    if (opts.drill) {
        log('   ⏸ 演练模式：内嵌测验不交卷');
        return false;
    }

    log('   📝 提交测验...');
    const ok = await submitQuiz(page, log, current());
    if (ok) log('   ✅ 已提交');
    return ok;
}

// 单个课程的完整学习流程
async function learnCourse(page, course, log, opts = {}) {
    const LIMIT = resolveLimit(opts);
    const ctx = current();
    ctx.emit('state', { phase: 'learn', label: '学习中', running: true, paused: false });
    log(`🎓 开始学习 ${course.courseKey} (tid=${course.termId})`);
    if (!course.termId) log('   ⚠️ 地址里没带 tid 参数，可能需要从课程首页重新进入');

    log('   正在打开课程页，首次加载可能要几十秒...');
    await gotoWithRetry(page, `${course.url}#/learn/content`, log);
    await page.waitForTimeout(6000);
    await checkpoint();

    // 上次的记录：知道做到哪了，也知道哪些是失败过的
    const history = progress.load(course.courseKey);
    const doneBefore = Object.values(history.tasks || {}).filter(t => t.status === 'done').length;
    const failedBefore = progress.pendingFromLastRun(course.courseKey);
    if (doneBefore > 0) log(`📖 上次已完成 ${doneBefore} 项，本次直接跳过`);
    if (failedBefore.length > 0) log(`🔁 上次有 ${failedBefore.length} 项没成，本次优先重试`);
    const failedCids = new Set(failedBefore.map(t => t.cid));

    await ensureChaptersExpanded(page, log);

    let round = 0;
    let doneCount = 0;
    let failStreak = 0;
    const MAX_FAIL_STREAK = 5;
    const MAX_RETRY_PER_TASK = 2;
    const attempts = new Map(); // cid -> 已尝试次数，避免同一任务点无限重试

    // 测验和讨论都只能做一次。重试等于重新答一遍再交一次 / 再发一帖，
    // 前者烧提交机会，后者在讨论区留下重复内容。宁可漏掉，也不能自动重来。
    const maxAttempts = (task) => (task.type === '测验' || task.type === '讨论' ? 1 : MAX_RETRY_PER_TASK);

    let tasks = [];
    while (true) {
        await checkpoint();
        round++;
        tasks = await collectTasks(page);
        emitTasks(ctx, tasks, course);
        if (tasks.length === 0) {
            log('⚠️ 未找到任何任务点，可能页面结构变化');
            break;
        }

        const pending = tasks.filter(t =>
            !t.learned &&
            !SKIP_TYPES.has(t.type) &&
            (attempts.get(t.cid) || 0) < maxAttempts(t)
        );

        // 上次失败过的排前面，先补这些再往下走
        if (failedCids.size > 0) {
            pending.sort((a, b) => (failedCids.has(b.cid) ? 1 : 0) - (failedCids.has(a.cid) ? 1 : 0));
        }

        if (pending.length === 0) {
            const learned = tasks.filter(t => t.learned).length;
            const stuck = tasks.filter(t => !t.learned && !SKIP_TYPES.has(t.type)).length;
            log(`🏁 可自动化任务已全部处理（${learned}/${tasks.length} 已标记完成${stuck ? `，${stuck} 个多次未能完成` : ''}）`);

            // 剩下的多半是测验，交给后面的测验流程接着处理
            const pendingQuiz = tasks.filter(t => !t.learned && t.type === '测验').length;
            const pendingTalk = tasks.filter(t => !t.learned && t.type === '讨论').length;
            if (pendingQuiz > 0 || pendingTalk > 0) {
                log(`   还剩 ${pendingQuiz} 个测验、${pendingTalk} 个讨论未处理`);
            }
            break;
        }

        const task = pending[0];
        emitTasks(ctx, tasks, course, task.cid);
        ctx.emit('progress', {
            scope: 'current', current: 0, total: 1, percent: 0,
            label: `${task.type} · ${task.text}`, detail: '正在处理'
        });
        log(`\n▶️ [剩余 ${pending.length}] ${task.type} - ${task.text}`);

        const entered = await enterTask(page, task, log);
        if (!entered) {
            failStreak++;
            await backToList(page);
            await ensureChaptersExpanded(page, log);
            if (failStreak >= MAX_FAIL_STREAK) {
                log('⚠️ 连续失败过多，终止');
                break;
            }
            continue;
        }
        // 进入成功才计尝试次数：「没进去」什么都没做过，重试完全安全，
        // 不能烧掉测验/讨论唯一的一次机会
        attempts.set(task.cid, (attempts.get(task.cid) || 0) + 1);

        if (task.type === '视频') {
            await playVideo(page, log, config.PLAYBACK_RATE);
        } else if (task.type === '测验') {
            await handleInlineQuiz(page, log, opts);
        } else if (task.type === '讨论') {
            await handleDiscussion(page, log);
        } else {
            await handleDocument(page, log, config.DOCUMENT_STAY_MS);
        }

        // 回到列表并核对完成状态
        await backToList(page);
        await ensureChaptersExpanded(page, log);

        const after = (await collectTasks(page)).find(t => t.cid === task.cid);
        const rec = { type: task.type, title: task.text, cid: task.cid };

        if (after && after.learned) {
            doneCount++;
            failStreak = 0;
            progress.mark(course.courseKey, task.cid, { ...rec, status: 'done' });
            emitTasks(ctx, tasks.map(t => t.cid === task.cid ? { ...t, learned: true } : t), course);
            log(`   ✅ 已完成并记录：${task.type} · ${task.text}（本轮第 ${doneCount} 项）`);
        } else if (task.type === '测验') {
            progress.mark(course.courseKey, task.cid, { ...rec, status: 'failed' });
            // 不重试：重新答题再交一次会白烧一次提交机会
            log('   ⚠️ 该测验未确认完成，不再重试（避免重复消耗机会）');
            log('      可能是没提交成功，也可能平台还没标记，请手动打开确认');
            failStreak++;
        } else if (task.type === '讨论') {
            progress.mark(course.courseKey, task.cid, { ...rec, status: 'failed' });
            // 同理：重试会在讨论区留下重复内容
            log('   ⚠️ 讨论未确认发出，不再重试（避免重复发帖）');
            failStreak++;
        } else {
            progress.mark(course.courseKey, task.cid, { ...rec, status: 'failed' });
            failStreak++;
            log(`   ⚠️ 未标记完成（连续失败 ${failStreak}/${MAX_FAIL_STREAK}）`);
            if (failStreak >= MAX_FAIL_STREAK) {
                log('⚠️ 连续失败过多，终止');
                break;
            }
        }

        if (round > tasks.length * 3) {
            log('⚠️ 循环次数异常，终止');
            break;
        }

        if (doneCount >= LIMIT) {
            log(`⏹ 已达到 --limit 限制（${LIMIT}），停止`);
            break;
        }
    }

    // 收尾对账复用循环里最后一次扫描：每条退出路径（任务处理完、进入失败重试、
    // 连续失败终止）都紧跟过一次展开+扫描，页面状态没变，不必再全量重扫
    const finalTasks = tasks;
    const recorded = progress.load(course.courseKey).tasks || {};
    const stillPending = finalTasks.filter(t => !t.learned && !SKIP_TYPES.has(t.type));

    log('');
    log('━━━ 收尾检查 ━━━');
    if (stillPending.length === 0) {
        log(`  ✅ 目录共 ${finalTasks.length} 个任务点，已全部完成，没有遗漏`);
    } else {
        log(`  ⚠️ 还有 ${stillPending.length} 个任务点没完成：`);
        for (const t of stillPending.slice(0, 8)) {
            const flag = recorded[t.cid]?.status === 'done' ? '　← 记录标了完成，但平台没确认' : '';
            log(`     ${t.type} · ${t.text}${flag}`);
        }
        if (stillPending.length > 8) log(`     ...另有 ${stillPending.length - 8} 个`);
    }

    log(`\n📊 ${course.courseKey} 处理结束，本轮完成 ${doneCount} 个任务点`);
    return {
        done: doneCount,
        total: finalTasks.length,
        learned: finalTasks.filter(t => t.learned).length,
        pending: stillPending.length
    };
}

module.exports = { learnCourse, emitTasks };
