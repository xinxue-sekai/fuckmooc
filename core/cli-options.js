const URL_RE = /^https?:\/\//;

// 命令行参数的唯一解析点。GUI 不读 argv，直接构造 RunOptions。
function parseArgs(argv = process.argv.slice(2)) {
    const first = argv.find(a => !a.startsWith('-')) || null;
    const target = first === 'icourse163' ? first : null;
    const url = argv.find(a => URL_RE.test(a)) || null;
    const limitArg = argv.find(a => a.startsWith('--limit='));
    const n = limitArg ? Number(limitArg.split('=')[1]) : 0;

    return {
        target,
        first,
        url,
        probe: argv.includes('--probe'),
        quiz: argv.includes('--quiz'),
        submit: argv.includes('--submit'),
        noQuiz: argv.includes('--no-quiz'),
        limit: Number.isFinite(n) && n > 0 ? n : 0
    };
}

module.exports = { parseArgs, URL_RE };
