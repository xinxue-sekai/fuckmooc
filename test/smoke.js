// 冒烟测试：只覆盖不需要浏览器的纯逻辑，几秒钟跑完。
// 用途是改完代码后确认「核心判断没走样」，不追求覆盖率。
// 运行：npm test

const assert = require('assert');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            pending.push(
                r.then(
                    () => { console.log(`  ✅ ${name}`); passed++; },
                    e => { console.log(`  ❌ ${name} → ${e.message}`); failed++; }
                )
            );
            return;
        }
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ❌ ${name} → ${e.message}`);
        failed++;
    }
}

console.log('\n【配置解析】');
const { num } = require('../core/config');
test('正常数字', () => assert.strictEqual(num('42', 0), 42));
test('非法值回退默认', () => assert.strictEqual(num('abc', 7), 7));
test('空值回退默认', () => assert.strictEqual(num(undefined, 3), 3));
test('0 不会被当成空值', () => assert.strictEqual(num('0', 9), 0));

console.log('\n【题干相似度】');
const { similarity } = require('../core/answer-bank');
test('同题不同标点 = 1', () => assert.strictEqual(similarity('我国的国体是', '我国的国体是（）'), 1));
test('一字之差低于阈值', () => assert.ok(similarity('我国的国体是', '我国的政体是') < 0.9));
test('无关题目接近 0', () => assert.ok(similarity('我国的国体是', '太阳系有几颗行星') < 0.2));
test('空输入返回 0', () => assert.strictEqual(similarity('', 'abc'), 0));

console.log('\n【选项映射】');
const { mapAnswer } = require('../core/answer-bank');
test('按内容跨顺序映射', () => {
    const bank = {
        answer: 'A',
        answer_options: 'A.阶级性与人民性的统一,B.阶级性与革命性的统一'
    };
    const page = [
        { key: 'A', text: '阶级性与革命性的统一' },
        { key: 'B', text: '阶级性与人民性的统一' }
    ];
    assert.deepStrictEqual(mapAnswer(bank, page), ['B']);
});
test('选项对不上时返回 null', () => {
    const bank = { answer: 'A', answer_options: 'A.完全无关的内容' };
    const page = [{ key: 'A', text: '另一个东西' }, { key: 'B', text: '再一个' }];
    assert.strictEqual(mapAnswer(bank, page), null);
});

console.log('\n【模型输出解析】');
const { extractJson } = require('../core/free-model');
test('裸 JSON', () => assert.deepStrictEqual(extractJson('{"answers":["A"]}').answers, ['A']));
test('代码块包裹', () => assert.deepStrictEqual(extractJson('```json\n{"answers":["B","C"]}\n```').answers, ['B', 'C']));
test('前后有废话', () => assert.deepStrictEqual(extractJson('答案是 {"answers":["D"]} 以上').answers, ['D']));
test('无效输入返回 null', () => assert.strictEqual(extractJson('完全没有 JSON'), null));

console.log('\n【页面文本清洗】');
const { clean } = require('../platform/icourse163/quiz');
test('去掉零宽字符', () => assert.strictEqual(clean('a\u200bb\u200ec\ufeff'), 'abc'));
test('合并空白', () => assert.strictEqual(clean('  a \n\t b  '), 'a b'));

console.log('\n【配置模块加载】');
test('icourse163 配置不杀进程', () => {
    const c = require('../platform/icourse163/config');
    assert.ok(typeof c.assertCourses === 'function');
    assert.ok(c.settings.QUIZ_BUDGET_MS > 0);
});

console.log('\n【运行方式读写（RUN_*，缺失不覆盖）】');
const fsSmoke = require('fs');
const osSmoke = require('os');
const pathSmoke = require('path');
const runSvc = require('../core/config-service');
test('局部保存不重置其他开关', () => {
    const tmp = pathSmoke.join(osSmoke.tmpdir(), `smoke-run-${process.pid}.txt`);
    runSvc.writeConfigValues({ ICOURSE_COURSE_URL: 'x' }, tmp);
    runSvc.setRunMode({ probe: true, limit: 2 }, tmp);
    runSvc.setRunMode({ quiz: true }, tmp);   // 只写给出的键
    const m = runSvc.getRunMode(tmp);
    assert.strictEqual(m.probe, true, '先前写入的 probe 须保留');
    assert.strictEqual(m.quiz, true);
    assert.strictEqual(m.limit, 2);
    assert.strictEqual(m.noQuiz, false, '未写入的开关保持默认');
    fsSmoke.unlinkSync(tmp);
});

console.log('\n【答题模型模块（三协议适配）】');
const llm = require('../core/llm');
test('未配置 Key 时不发请求直接报错', () =>
    llm.askText('hi', () => {}, { apiKey: '' }).then(
        () => { throw new Error('应当拒绝'); },
        e => assert.ok(/未配置/.test(e.message))
    ));
test('熔断可复位', () => {
    llm.reset();
    assert.strictEqual(llm.isDisabled(), false);
});
test('三协议请求构造与响应解析（openai/anthropic/gemini）', () => {
    const seen = {};
    const origFetch = global.fetch;
    global.fetch = async (url, init) => {
        seen[url] = init.headers;
        return { ok: true, json: async () => ({
            choices: [{ message: { content: 'OA' } }],
            content: [{ type: 'text', text: 'AN' }],
            candidates: [{ content: { parts: [{ text: 'GE' }] } }]
        }) };
    };
    return (async () => {
        assert.strictEqual(await llm.askText('hi', () => {}, { apiKey: 'k', protocol: 'openai', baseUrl: 'https://x', model: 'm1' }), 'OA');
        assert.strictEqual(seen['https://x/chat/completions'].authorization, 'Bearer k');
        assert.strictEqual(await llm.askText('hi', () => {}, { apiKey: 'k', protocol: 'anthropic', baseUrl: 'https://a', model: 'm2' }), 'AN');
        assert.strictEqual(seen['https://a/v1/messages']['x-api-key'], 'k');
        assert.strictEqual(await llm.askText('hi', () => {}, { apiKey: 'k', protocol: 'gemini', baseUrl: 'https://g', model: 'm3' }), 'GE');
        assert.ok(seen['https://g/models/m3:generateContent?key=k']);
        llm.reset();
    })().finally(() => { global.fetch = origFetch; });
});

Promise.all(pending).then(() => {
    console.log(`\n${passed} 通过，${failed} 失败\n`);
    process.exit(failed ? 1 : 0);
});
