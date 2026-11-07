const { current, checkpoint } = require('../../core/run-context');
const { searchInBank } = require('../../core/answer-bank');
const { searchAnswer } = require('../../core/web-search');
const { gotoHash } = require('./browser');
const freeModel = require('../../core/free-model');
const config = require('./config');
const llm = require('../../core/llm');

// 中国大学 MOOC 的章节测验。
// 平台每个测验只给 3 次有效提交且取最高分，没有试错空间，所以答完先核空题比例，
// 超标不交。提交语义：一键完成流程默认交卷；--quiz 单独跑默认演练，加 --submit 才交。

// 等待后检查控制状态：GUI 停止 / 暂停时及时响应，CLI 下 control 为 no-op。
async function wait(page, ms) {
    await page.waitForTimeout(ms);
    await checkpoint();
}

const ANSWER_PROMPT = [
    '你是答题助手。下面是考试题干和选项。',
    '请判断正确答案，只返回一个 JSON 对象，不要解释，不要 markdown 代码块。',
    '单选题返回 {"answers":["A"]}；多选题返回 {"answers":["A","C"]}。',
    '选项字母以题目给出的 A/B/C/D 为准。'
].join('\n');

function clean(text) {
    return String(text || '')
        .replace(/\u00a0/g, ' ')
        // 题干里混着零宽字符和方向控制符，不清掉会把题库相似度拉低
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// 抓取当前页面上所有题目
async function extractQuestions(page) {
    return page.evaluate(() => {
        const clean = (s) => String(s || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        return Array.from(document.querySelectorAll('.m-choiceQuestion')).map((q, idx) => {
            const stem = clean(q.querySelector('.j-richTxt')?.innerText || '');
            const cate = clean(q.querySelector('.qaCate')?.innerText || '');
            const isJudge = /判断/.test(cate);
            const options = Array.from(q.querySelectorAll('li'))
                .map(li => {
                    const input = li.querySelector('input');
                    if (!input) return null;
                    const key = clean(li.querySelector('.optionPos')?.innerText || '').replace(/[.．、]/g, '');
                    let text = clean(li.querySelector('.optionCnt')?.innerText || '');
                    // 判断题的选项是 ✓ / ✗ 符号，取不到文字时用语义代替
                    if (!text && isJudge) text = key === 'A' ? '正确' : '错误';
                    return { key, text, type: input.type, id: input.id, name: input.name };
                })
                .filter(o => o && o.key);
            return { idx, stem, cate, isJudge, options };
        });
    });
}

// 组装题目提示词：题干 + 选项 + 题型附加说明。配置模型和免费模型共用同一份
function buildQuestionPrompt(question) {
    const lines = [`${question.stem}`];
    for (const o of question.options) lines.push(`${o.key}. ${o.text}`);

    const isMulti = question.options.some(o => o.type === 'checkbox');
    let prompt = ANSWER_PROMPT;
    if (isMulti) {
        prompt += '\n\n这是【多选题】，通常有 2 个或更多正确答案，必须把所有正确的选项全部选上，不要只选一个。';
    }
    if (question.isJudge) {
        prompt += '\n\n这是【判断题】：选项 A 表示该说法正确，选项 B 表示该说法错误。只返回一个答案字母。';
    }
    return `${prompt}\n\n${lines.join('\n')}`;
}

// 模型返回的 {answers:["A"]} 解析成字母数组，解析不出返回 []
function parseAnswerKeys(text) {
    const answers = freeModel.extractJson(text)?.answers;
    return Array.isArray(answers)
        ? answers.map(a => String(a).trim().toUpperCase()).filter(a => /^[A-Z]$/.test(a))
        : [];
}

async function askModel(question, log, tier = 'fast') {
    try {
        const text = await freeModel.askText(buildQuestionPrompt(question), log, tier);
        const keys = parseAnswerKeys(text);
        if (keys.length > 0) return keys;
    } catch (e) {
        log(`      ⚠️ 模型答题失败: ${e.message}`);
    }
    return [];
}

// 决定一道题的答案：配置模型 → 题库 → 网页搜索 → 纯模型
// 配置的模型排最前，准确率最高；代价是每题多花几秒
async function decide(question, page, log) {
    if (question.options.length === 0) return { keys: [], source: 'none' };

    // LLM 走 OpenAI 兼容 API（在「设置 → 配置模型」里配）。答案直接取字母：
    // 选项列表是原样发给它的，不存在搜索那种顺序错乱问题
    if (config.LLM_ENABLED && config.LLM_API_KEY && !llm.isDisabled()) {
        try {
            const keys = parseAnswerKeys(
                await llm.askText(buildQuestionPrompt(question), log, {
                    apiKey: config.LLM_API_KEY,
                    baseUrl: config.LLM_BASE_URL || undefined,
                    model: config.LLM_MODEL || undefined,
                    protocol: config.LLM_PROTOCOL || 'openai'
                })
            );
            if (keys.length > 0) return { keys, source: 'llm' };
        } catch (e) {
            log(`      ⚠️ 模型答题失败: ${e.message}`);
        }
    }

    const hit = await searchInBank(question.stem, question.options, log);
    if (hit && hit.keys.length > 0) return { keys: hit.keys, source: 'bank' };

    if (page) {
        const web = await searchAnswer(page, question, log);
        if (web && web.keys.length > 0) return { keys: web.keys, source: 'search' };
    }

    let keys = await askModel(question, log);

    // 多选题只回一个答案，基本等于必错。换强档再问一次，仍不行就带着答案交，不阻塞流程
    const isMulti = question.options.some(o => o.type === 'checkbox');
    if (isMulti && keys.length === 1) {
        log('      ⚠️ 多选题只给了 1 个答案，换强模型重答');
        const retry = await askModel(question, log, 'strong');
        if (retry.length > 1) {
            log(`      ✅ 重答得到 ${retry.join(',')}`);
            keys = retry;
        } else {
            log('      ⚠️ 仍只有 1 个答案，按现有答案提交（该题存疑）');
        }
    }

    return { keys, source: keys.length ? 'model' : 'none' };
}

// 按选项 id 点击，模拟真实交互。label 被遮挡时两次点击都可能空转，
// 所以点击后核实 input 真的勾上了，没勾上由调用方按空题处理
async function clickOption(page, option, log) {
    const sel = `#${option.id}`;
    try {
        await page.locator(`label[for="${option.id}"]`).click({ timeout: 5000 });
    } catch {
        await page.locator(sel).click({ force: true, timeout: 5000 }).catch(() => {});
    }
    return page.evaluate(id => !!document.getElementById(id)?.checked, option.id).catch(() => false);
}

// 清掉已经勾上的复选框。radio 点新选项会自动覆盖，复选框不会，会叠加成错误答案
async function clearChecked(page, log) {
    const n = await page.evaluate(() => {
        const boxes = document.querySelectorAll('.m-choiceQuestion input[type="checkbox"]:checked');
        boxes.forEach(el => {
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return boxes.length;
    }).catch(() => 0);
    if (n > 0) log(`   🧹 已清除 ${n} 个残留选项`);
    return n;
}

async function answerAll(page, log, deadline) {
    const questions = await extractQuestions(page);
    if (questions.length === 0) {
        log('⚠️ 没有读到题目');
        return { results: [], total: 0 };
    }
    log(`📋 共 ${questions.length} 道题`);

    // 上次可能答到一半就中断了，残留的多选会和新答案叠加
    await clearChecked(page, log);

    const results = [];
    let bankHits = 0;
    let searchHits = 0;
    let llmHits = 0;
    let modelHits = 0;
    let misses = 0;

    for (const q of questions) {
        if (deadline && Date.now() > deadline) {
            const left = questions.length - results.length;
            log(`⏰ 时间预算用尽，剩余 ${left} 题不再作答`);
            break;
        }

        const multi = q.options.some(o => o.type === 'checkbox');
        log(`\n  第 ${q.idx + 1} 题 [${q.cate || (multi ? '多选' : '单选')}] ${q.stem.slice(0, 50)}`);
        current().emit('progress', {
            scope: 'current', current: q.idx + 1, total: questions.length,
            percent: Math.round((q.idx + 1) / questions.length * 100),
            label: `第 ${q.idx + 1} 题`, detail: `${q.idx + 1} / ${questions.length}`
        });

        const { keys, source } = await decide(q, page, log);
        if (keys.length === 0) {
            misses++;
            log('      ❌ 没有拿到答案，留空');
            results.push({ idx: q.idx, stem: q.stem, keys: [], source: 'none', answered: false });
            continue;
        }

        if (source === 'bank') bankHits++;
        else if (source === 'search') searchHits++;
        else if (source === 'llm') llmHits++;
        else modelHits++;
        const label = { bank: '题库', search: '搜索', llm: '模型', model: '免费模型' }[source] || source;
        log(`      ✅ ${label}答案: ${keys.join(',')}`);

        let checkedAny = false;
        for (const k of keys) {
            const opt = q.options.find(o => o.key === k);
            if (!opt) {
                log(`      ⚠️ 选项 ${k} 不存在，跳过`);
                continue;
            }
            if (await clickOption(page, opt, log)) checkedAny = true;
            await wait(page, 600 + Math.random() * 800);
        }
        await wait(page, 800);
        // answered 以真实勾选为准：答案字母对不上页面、点击空转都按空题计，
        // 否则空题比例保护会被绕过，带空卷交出去白白烧机会
        results.push({ idx: q.idx, stem: q.stem, keys, source, answered: checkedAny });
    }

    log(`\n📊 本轮：题库 ${bankHits}，搜索 ${searchHits}，${llmHits}，模型 ${modelHits}，未答 ${misses}`);
    return { results, total: questions.length };
}

// 在一组同文本元素里找第一个可见的。DOM 里常有隐藏模板或其他区块带同名文本，
// 按 last()/first() 定位会点空或点错对象
async function firstVisible(loc) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
    }
    return null;
}

// 判断当前页面是否处于「已交卷」状态：进了成绩页 / 出现提交成功提示 / 选项锁定
async function submittedState(page) {
    return page.evaluate(() => {
        const body = (document.body.innerText || '').replace(/\s+/g, ' ');
        if (location.hash.includes('quizscore')) return { ok: true, why: '已进入成绩页' };
        if (/已提交|提交成功|交卷成功|本次得分/.test(body)) return { ok: true, why: '出现提交成功提示' };

        const inputs = Array.from(document.querySelectorAll('.m-choiceQuestion input'));
        if (inputs.length > 0 && inputs.every(i => i.disabled)) return { ok: true, why: '选项已锁定' };
        return { ok: false, hash: location.hash };
    }).catch(() => ({ ok: false, hash: '' }));
}

// 交卷前按页面真实勾选复核空题数：点击可能空转，一切以 input:checked 为准
async function countUnchecked(page) {
    return page.evaluate(() => {
        let empty = 0;
        document.querySelectorAll('.m-choiceQuestion').forEach(q => {
            if (q.querySelectorAll('input:checked').length === 0) empty++;
        });
        return empty;
    }).catch(() => 0);
}

// 提交试卷：点提交 → 确认弹层 → 判断是否真的交上了
// 独立测验页用 .j-submitBtn；章节里内嵌的课后测验按钮就是一段文字「提交」
async function submitQuiz(page, log, ctx) {
    const runCtx = ctx || current();
    // GUI 上下文丢失时不静默交卷；CLI 显式注入的 noopCtx（mode:'cli'）放行
    if (runCtx.mode === 'gui' && typeof runCtx.confirm !== 'function') {
        throw new Error('GUI context lost');
    }
    if (!await runCtx.confirm('submit')) {
        log('   ⏸ 已取消交卷');
        return false;
    }
    let btn = page.locator('.j-submitBtn').first();
    if (await btn.count() === 0) {
        btn = await firstVisible(page.getByText('提交', { exact: true }));
    }
    if (!btn || await btn.count() === 0) {
        log('   ⚠️ 没找到提交按钮');
        return false;
    }
    await btn.click({ timeout: 10000 }).catch(() => {});
    await wait(page, 2500);

    // 确认弹层的按钮类名不固定，按可见文本定位；带空题交卷时平台会再弹
    // 「仍有 N 题未作答」的二次确认，循环点到弹层消失为止
    for (let round = 0; round < 3; round++) {
        let target = null;
        for (const t of ['确定', '确认提交', '确定提交', '确认']) {
            const el = await firstVisible(page.getByText(t, { exact: true }));
            if (el) { target = { el, t }; break; }
        }
        if (!target) break;
        await target.el.click({ timeout: 5000 }).catch(() => {});
        log(`   🖱 已点「${target.t}」`);
        await wait(page, 2000);
        const more = await page.evaluate(() =>
            /未作答|未回答|还有\s*\d+\s*道?题/.test((document.body.innerText || ''))
        ).catch(() => false);
        if (!more) break;
    }

    // 内嵌测验提交后不跳转，只靠 hash 判断会一直失败，这里多给平台几秒标记，再看三个迹象
    await wait(page, 8000);

    const result = await submittedState(page);

    if (result.ok) {
        log(`   ✅ 提交成功（${result.why}）`);
    } else {
        log(`   当前视图: ${result.hash || '未知'}，未能确认提交结果`);
    }
    return result.ok;
}

// 从结果页读出得分
async function readScore(page) {
    // 成绩页是异步渲染的，固定等 3 秒有时还没出数，轮询几次更稳
    for (let i = 0; i < 5; i++) {
        await wait(page, 2000);
        const text = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
        const m = text.match(/本次得分为[：:]\s*([\d.]+)\s*\/\s*([\d.]+)/)
            || text.match(/得分[^0-9]{0,6}([\d.]+)\s*\/\s*([\d.]+)\s*分/);
        if (m) return { score: Number(m[1]), total: Number(m[2]) };
    }
    return null;
}

// 在已打开的测验页里完成一次作答（可选提交）
async function doOneQuiz(page, log, opts = {}) {
    // 已交过的测验直接跳过：平台标记翻转慢时列表会把它当成没做，重进重答
    // 会再走一遍作答+提交，白白多烧一次机会
    if ((await submittedState(page)).ok) {
        log('   ⏭ 该测验已提交过，跳过');
        return null;
    }

    const needStart = await page.evaluate(() => {
        const b = document.querySelector('.j-startBtn');
        return !!b && document.querySelectorAll('.m-choiceQuestion').length === 0;
    }).catch(() => false);

    if (needStart) {
        const agree = page.locator('input.j-agree').first();
        if (await agree.count() > 0) {
            // 只设 checked 不生效，需要原生 click 翻转
            await agree.evaluate(el => { el.checked = false; el.click(); });
            await wait(page, 800);
        }
        const disabled = await page.evaluate(() => {
            const b = document.querySelector('.j-startBtn');
            return b ? b.classList.contains('u-btn-disabled') : true;
        });
        if (disabled) {
            log('   ⚠️ 开始按钮仍是禁用状态');
            return null;
        }
        await page.locator('.j-startBtn').click({ timeout: 15000 });
        await wait(page, 12000);
    }

    // 从点开始计时，平台限时 30 分钟，预算留出提交余量
    const deadline = Date.now() + config.QUIZ_BUDGET_MS;
    let outcome = await answerAll(page, log, deadline);
    // 慢机器上题面可能比固定等待渲染得慢；读空时短轮询补读，避免整场按空卷放弃
    // （此时平台的 30 分钟已开始计时，放弃就是白跑一趟）
    for (let i = 0; outcome.total === 0 && i < 2; i++) {
        log('   ⏳ 题面还没渲染出来，等 5 秒重读');
        await wait(page, 5000);
        outcome = await answerAll(page, log, deadline);
    }

    if (!opts.submit) {
        log('   ⏸ 未提交（加 --submit 才会提交）');
        return null;
    }

    // 答不完就不交：这个平台每个测验只有 3 次机会，留白交卷等于白白浪费一次
    const total = outcome.total || 0;
    const answered = outcome.results.filter(r => r.answered).length;
    // 点击可能空转，空题数取「统计值」与「页面真实勾选复核」里更保守的那个
    const missed = Math.max(total - answered, await countUnchecked(page));
    const missRatio = total > 0 ? missed / total : 1;

    if (missRatio > config.QUIZ_MAX_MISS_RATIO) {
        // 答案异常，「本场不再提示」缓存立即失效
        current().resetSkipConfirm?.();
        log('');
        log(`   🛑 ${total} 道题里有 ${missed} 道没答出来（${Math.round(missRatio * 100)}%），超过 ${Math.round(config.QUIZ_MAX_MISS_RATIO * 100)}% 的容忍上限`);
        log('      这次不提交，机会给你留着。');
        log('      已经勾选的答案会留在页面上，下次进来可以直接看。');
        return null;
    }

    const ok = await submitQuiz(page, log, opts.ctx || current());
    if (!ok) return null;

    const score = await readScore(page);
    if (score) {
        log(`   📊 本次得分 ${score.score} / ${score.total}`);
    } else {
        log('   📊 已提交，但没读到分数（成绩页可能还没渲染完，不影响结果）');
    }
    // 必须带上 submitted：交成功了但读不到分数，不能被上层当成「没交」；
    // score 为 null 表示没读到分，上层据此把它和真 0 分分开统计
    return {
        submitted: true,
        score: score ? score.score : null,
        total: score ? score.total : 0
    };
}

// 处理「测验与作业」页里的所有测验
async function runQuizzes(page, course, log, opts = {}) {
    await page.goto(`${course.url}#/learn/testlist`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(page, 6000);

    const items = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.u-quizHwListItem')).map((it, i) => {
            const text = (it.innerText || '').replace(/\s+/g, ' ').trim();
            const titleEl = it.querySelector('.j-name, .name, h4, h3');
            const title = (titleEl?.innerText || '').replace(/\s+/g, ' ').trim() || text.slice(0, 20);
            // 页面上是「有效分数 12.00/15.00」。不能用通用分数正则，
            // 否则截断时间「2026/12/29 23:30」里的 2026/12 会被当成得分；
            // 已交未出分的场次列表会写「已提交」，同样视为已完成
            const m = text.match(/有效分数\s*([\d.]+)\s*\/\s*([\d.]+)/);
            const got = m ? Number(m[1]) : 0;
            const answered = /已提交|已作答|已经提交/.test(text);
            return { i, title, done: got > 0 || answered, got, text: text.slice(0, 100) };
        })
    );

    const todo = items.filter(it => !it.done);
    log(`📝 共 ${items.length} 个测验，其中 ${todo.length} 个还没做`);

    if (todo.length === 0) {
        log('   ✅ 测验都已完成，没有要做的');
        return;
    }

    const limit = opts.limit || todo.length;
    const target = todo.slice(0, limit);
    let submitted = 0;
    let skipped = 0;
    let unreadScore = 0;
    let totalScore = 0;

    for (let n = 0; n < target.length; n++) {
        const item = target[n];
        log(`\n━━━ [${n + 1}/${target.length}] ${item.title} ━━━`);
        current().emit('state', { phase: 'quiz', label: '答题中', running: true, paused: false });
        current().emit('progress', {
            scope: 'current', current: n + 1, total: target.length,
            percent: Math.round((n + 1) / target.length * 100),
            label: item.title, detail: `${n + 1} / ${target.length}`
        });

        // 场次间用 hash 导航切回列表页：SPA 原生路由，省一次整页冷加载
        await gotoHash(page, '#/learn/testlist');
        await wait(page, 5000);

        // 用「列表行」定位再取行内按钮。不做全局序号回退：列表混排作业行时
        // 按钮序列会错位，按序号猜会点进别的测验；行内没有就跳过，下轮再来
        const entry = page.locator('.u-quizHwListItem').nth(item.i).locator('a.j-quizBtn').first();
        if (await entry.count() === 0) {
            log('   ⚠️ 没有「前往测验」入口，跳过');
            continue;
        }
        await entry.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await entry.click({ timeout: 8000 }).catch(e => log(`   ⚠️ 点击入口失败: ${e.message.slice(0, 60)}`));
        await wait(page, 8000);

        const hash = await page.evaluate(() => location.hash).catch(() => '');
        if (!hash.includes('/quiz')) {
            log(`   ⚠️ 没进入测验页（${hash}），跳过`);
            continue;
        }

        try {
            const r = await doOneQuiz(page, log, opts);
            if (r && r.submitted) {
                submitted++;
                // 读不到分数和真 0 分是两回事，分开统计免得总账虚低
                if (r.score == null) {
                    unreadScore++;
                    log(`   ✅ ${item.title} 已提交（成绩页还没渲染出分数）`);
                } else {
                    totalScore += r.score;
                    log(`   ✅ ${item.title} 完成，得分 ${r.score}/${r.total}`);
                }
            } else {
                skipped++;
                log(`   ⏸ ${item.title} 未提交，已跳过`);
            }
        } catch (e) {
            log(`   ❌ 处理失败: ${e.message}`);
        }

        // 演练模式只跑一个，看完再决定
        if (!opts.submit) {
            log('\n⏸ 当前为演练模式，停止后续测验');
            break;
        }
    }

    const bits = [`提交 ${submitted}`];
    if (skipped > 0) bits.push(`跳过 ${skipped}`);
    if (unreadScore > 0) bits.push(`${unreadScore} 场已交未读到分`);
    log(`\n📊 测验结果：${bits.join('，')}${totalScore ? `，累计得分 ${totalScore}` : ''}`);
    return { handled: submitted, submitted, skipped, unreadScore, total: items.length, todo: todo.length, score: totalScore };
}

module.exports = { clean, submitQuiz, doOneQuiz, runQuizzes, submittedState, countUnchecked };
