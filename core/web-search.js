// 网页搜索答题：把题干丢进搜索引擎，从结果里找标准答案
//
// 两个要点：
// 1. 不能直接用搜到的字母——不同题库的选项顺序不一样，必须按选项文字重新匹配
// 2. 搜索引擎会限流，所以要轮换多个引擎，并记住哪个已经失效，别每题都去撞一遍

const { similarity, normalize } = require('./answer-bank');
const freeModel = require('./free-model');

// 按实测质量排序：搜狗和百度的结果里直接带标准答案，其余作为兜底
const ENGINES = [
    { name: '搜狗', url: q => `https://www.sogou.com/web?query=${encodeURIComponent(q)}` },
    { name: '百度', url: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
    { name: '头条', url: q => `https://so.toutiao.com/search?keyword=${encodeURIComponent(q)}` },
    { name: '360', url: q => `https://www.so.com/s?q=${encodeURIComponent(q)}` },
    { name: '神马', url: q => `https://m.sm.cn/s?q=${encodeURIComponent(q)}` }
];

const SNIPPET_LIMIT = 1800;
const SEARCH_GAP_MS = 900;

// 本轮各引擎的连续失败次数，失败的排到后面
const health = new Map();
const DEAD_THRESHOLD = 3;

function rankedEngines() {
    // 连续失败 3 次的直接跳过：日志里「结果不相关」累计 651 次，大半是这类引擎在反复白等
    const alive = ENGINES.filter(e => (health.get(e.name) || 0) < DEAD_THRESHOLD);
    const pool = alive.length > 0 ? alive : [...ENGINES];
    return pool.sort((a, b) => (health.get(a.name) || 0) - (health.get(b.name) || 0));
}

function markFail(name) {
    health.set(name, (health.get(name) || 0) + 1);
}

function markOk(name) {
    health.set(name, 0);
}

function resetHealth() {
    health.clear();
}

// 搜狗、百度的 AI 解题内容是流式补进去的。
// 页面骨架往往几百字就停住了，这时候如果按「长度不变」判定加载完，
// 抓到的就是还没有 AI 解题的半成品——题干都不在里面，后面自然被判成「不相关」。
// 所以：看到「答案」立刻走；没看到就一直等到上限。
async function waitForContentStable(sp, maxMs = 10000) {
    const step = 700;
    const start = Date.now();
    let prevLen = -1;
    let stable = 0;
    while (Date.now() - start < maxMs) {
        await sp.waitForTimeout(step);
        const info = await sp.evaluate(() => {
            const t = document.body.innerText || '';
            return { len: t.length, hasAnswer: /答案\s*[:：]|参考答案|正确答案/.test(t) };
        }).catch(() => ({ len: 0, hasAnswer: false }));

        // 答案已经露出来了，再给 1.5 秒让后面的解析补完就走
        if (info.hasAnswer && info.len > 800) {
            await sp.waitForTimeout(1500);
            return;
        }

        // 内容已经很长还连续不动，才认为真的加载完了
        if (info.len > 1200 && info.len === prevLen) {
            stable++;
            if (stable >= 4) return;
        } else {
            stable = 0;
        }
        prevLen = info.len;
    }
}

// 用独立标签页搜索，避免破坏正在作答的页面
// queryText 是真正丢给引擎的词，probeText 是原始题干——预检必须拿题干比对，
// 因为查询词可能被加过后缀（比如判断题加了「判断题」三个字）
async function fetchSnippet(page, queryText, probeText, engine, log = () => {}) {
    const context = page.context();
    const sp = await context.newPage();
    try {
        await sp.goto(engine.url(queryText), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForContentStable(sp);

        // 抓取范围决定后面模型能不能读到答案。
        // 这里以「题干在正文中出现的位置」为中心向两边截，保证题干、选项、答案落在同一段里；
        // 找不到题干才退回「AI解题」锚点。
        const stemHead = String(probeText || '').slice(0, 8);
        const text = await sp.evaluate((head) => {
            const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
            const body = clean(document.body.innerText);
            const idx = head ? body.indexOf(head) : -1;
            if (idx >= 0) {
                const start = Math.max(0, idx - 150);
                return body.slice(start, start + 2000);
            }
            const anchor = body.indexOf('AI解题');
            return anchor > 0 ? body.slice(anchor, anchor + 1800) : body.slice(0, 1800);
        }, stemHead);

        if (!text || text.length < 80) {
            log(`   🔎 ${engine.name} 没有返回内容`);
            markFail(engine.name);
            return '';
        }
        if (/验证码|安全验证|访问异常|请稍后再试/.test(text.slice(0, 300))) {
            log(`   🔎 ${engine.name} 要求验证`);
            markFail(engine.name);
            return '';
        }

        // 正文里连题干都没出现，多半是这个引擎没搜到相关结果。
        // 但搜索引擎会改写题干（省略号、截断），所以只在正文很短时才判死；
        // 内容够长就交给模型判断，不在这里一刀切
        const flat = normalize(text);
        const probe = normalize(probeText).slice(0, 8);
        if (probe && !flat.includes(probe) && text.length < 1500) {
            log(`   🔎 ${engine.name} 结果不相关，跳过`);
            // 也算一次失败：否则一个长期搜不到东西的引擎会每题都被排到前面，白等
            markFail(engine.name);
            return '';
        }

        return text.slice(0, SNIPPET_LIMIT);
    } catch (e) {
        log(`   🔎 ${engine.name} 搜索失败: ${e.message}`);
        markFail(engine.name);
        return '';
    } finally {
        await sp.close().catch(() => {});
    }
}

function buildPrompt(question, snippet) {
    const lines = [
        '下面是一道考试题，以及从网页上抓到的资料。资料里可能混着好几道题的答案。',
        '',
        '要求：',
        '1. 只找「题目」这一道题的答案，别被资料里其他题目带偏。',
        '2. 答案通常紧跟在题干后面，形如「答案 A」「答案：B」「答案 正确」「参考答案 A,B」。',
        '3. 资料里的选项顺序可能和题目不同，所以不要回答字母，直接返回正确选项的文字内容。',
        '4. 如果找不到，或者找到的答案文字和给出的选项都对不上，返回 {"answers":[]}，不要猜。',
        '',
        '只返回 JSON，例如 {"answers":["立大志"]}；多个答案就放多个。',
        '',
        `题目：${question.stem}`,
        '选项：'
    ];
    for (const o of question.options) lines.push(`${o.key}. ${o.text}`);
    lines.push('', `资料：${snippet}`);
    return lines.join('\n');
}

// 判断题兜底：资料里常直接写「答案 正确 / 错误」，比让模型转述可靠。
// 只在模型没给出答案时才用，避免覆盖模型更准的判断。
function fallbackByRegex(snippet, question) {
    if (!question.isJudge) return null;
    const m = String(snippet || '').match(/答案\s*[:：]?\s*(正确|错误|对|错|是|否|[√×✓✗])/);
    if (!m) return null;

    const word = m[1];
    const isTrue = /正确|对|是|√|✓/.test(word);
    const hit = question.options.find(o =>
        isTrue ? /正确|对|√|✓|是/.test(o.text) : /错误|错|×|✗|否/.test(o.text)
    );
    return hit ? [hit.key] : null;
}

// 把模型返回的答案文字映射成页面上的选项字母
function mapByText(answers, options) {
    const keys = [];
    for (const ans of answers) {
        let best = null;
        for (const o of options) {
            const s = similarity(String(ans), o.text);
            if (!best || s > best.s) best = { key: o.key, s };
        }
        // 文字对不上说明答案和本题无关，宁可放弃
        if (best && best.s >= 0.5) keys.push(best.key);
    }
    return Array.from(new Set(keys));
}

// 按命中概率从高到低排查询变体。
// - 判断题：题干是陈述句，加「判断题」才容易撞上题库页
// - 带空括号的题：换成「什么」，搜索引擎更容易匹配到问答页
// - 都搜不到时：把选项文字也带上，选项是这道题独有的特征
function buildQueries(question) {
    const stem = question.stem;
    const hasBlank = /[（(]\s*[)）]/.test(stem);

    const out = [];
    if (question.isJudge) out.push(`${stem} 判断题`);
    out.push(stem);
    if (hasBlank) out.push(stem.replace(/[（(]\s*[)）]/g, '什么'));
    if (question.isJudge) out.push(`${stem} 答案`);

    // 选项全带上搜索词会超过 80 字，引擎容易把尾部截掉，所以只取前 3 个
    if (!question.isJudge && question.options.length >= 2) {
        const optText = question.options.slice(0, 3).map(o => o.text).filter(Boolean).join(' ');
        if (optText) out.push(`${stem} ${optText}`);
    }

    return out;
}

async function searchAnswer(page, question, log = () => {}) {
    if (!question.stem || question.stem.length < 6) return null;

    // 变体越多搜得越久，所以每个变体只走前两个引擎；单选题只有一个变体，走全部引擎
    const queries = buildQueries(question);
    const perQuery = queries.length > 1 ? 2 : ENGINES.length;

    for (const q of queries) {
        for (const engine of rankedEngines().slice(0, perQuery)) {
            const snippet = await fetchSnippet(page, q, question.stem, engine, log);
            if (!snippet) {
                await new Promise(r => setTimeout(r, SEARCH_GAP_MS));
                continue;
            }

            // 判断题的答案往往直接写在资料里（「答案 正确」），先扫一遍。
            // 命中就不用调模型了——免费额度紧张时这条能省下大量调用
            const quick = fallbackByRegex(snippet, question);
            if (quick) {
                markOk(engine.name);
                log(`   📐 资料原文直接给出答案 → ${quick.join(',')}（省一次模型调用）`);
                return { keys: quick, source: 'search-regex', answers: quick, engine: engine.name };
            }

            try {
                const text = await freeModel.askText(buildPrompt(question, snippet), log);
                const parsed = freeModel.extractJson(text);
                const answers = parsed?.answers;
                if (!Array.isArray(answers) || answers.length === 0) {
                    log('   🔎 参考资料里没找到这道题');
                    await new Promise(r => setTimeout(r, SEARCH_GAP_MS));
                    continue;
                }
                const keys = mapByText(answers, question.options);
                if (keys.length > 0) {
                    markOk(engine.name);
                    log(`   🌐 ${engine.name} 命中: ${answers.join(' / ')} → ${keys.join(',')}`);
                    return { keys, source: 'search', answers, engine: engine.name };
                }
                log('   🔎 搜索到的答案和选项对不上');
            } catch (e) {
                log(`   🔎 搜索答案解析失败: ${e.message}`);
                // 模型挂了不代表资料不能用，判断题的原文答案还能救一下
                const fb = fallbackByRegex(snippet, question);
                if (fb) {
                    log(`   📐 改按资料原文兜底 → ${fb.join(',')}`);
                    return { keys: fb, source: 'search-regex', answers: fb, engine: engine.name };
                }
            }
            await new Promise(r => setTimeout(r, SEARCH_GAP_MS));
        }
    }
    return null;
}

module.exports = { searchAnswer, resetHealth };
