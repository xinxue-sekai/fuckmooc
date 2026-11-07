const path = require('path');
const fs = require('fs');
const { getCourses, ensureDirs, DATA_DIR, PROFILE_DIR, assertCourses, reloadSettings, settings } = require('./config');
const { launchBrowser } = require('./browser');
const { prepareProfile } = require('./profile');
const { ensureLoggedIn } = require('./login');
const { probeCourse } = require('./course');
const { learnCourse } = require('./learn');
const { createLogger } = require('../../core/logger');
const { parseArgs } = require('../../core/cli-options');
const { current } = require('../../core/run-context');
const { resetHealth: resetBankHealth } = require('../../core/answer-bank');
const { resetHealth: resetSearchHealth } = require('../../core/web-search');
const { resetQuota } = require('../../core/free-model');
const llm = require('../../core/llm');

// 控制台输出同时落盘，便于长任务中断后回溯。
// 返回 { file, restore }：CLI 的「运行日志」文案仍用 file，run 结束复原 console 避免常驻进程叠加劫持。
function setupFileLog() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(DATA_DIR, `run-${stamp}.log`);
    const fmt = (args) => args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    // 日志里有颜色控制码，直接写进文件会变成一堆乱码，落盘前去掉
    const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { origLog(...a); try { fs.appendFileSync(file, stripAnsi(fmt(a)) + '\n'); } catch {} };
    console.error = (...a) => { origErr(...a); try { fs.appendFileSync(file, stripAnsi(fmt(a)) + '\n'); } catch {} };
    return {
        file,
        restore() { console.log = origLog; console.error = origErr; }
    };
}

async function run(options = {}) {
    if (!assertCourses()) return;

    ensureDirs();
    const { file: logFile, restore } = setupFileLog();
    // 每场开始先刷新运行参数、复位熔断：GUI 常驻进程里设置页改的值要下一场生效，
    // 上次 run 撞上的熔断（题库 / 搜索 / 免费池 / DeepSeek）也不该带进这一场
    reloadSettings();
    resetBankHealth();
    resetSearchHealth();
    resetQuota();
    llm.reset();
    // options 优先、缺失才回落 argv；argv 只在 core/cli-options.js 解析
    const argv = parseArgs();
    const ctx = current();
    const isGui = ctx.mode === 'gui';
    ctx.emit('state', { phase: 'env-check', label: '环境检查', running: true, paused: false });
    const probeMode = options.probe !== undefined ? options.probe : argv.probe;
    const quizMode = options.quiz !== undefined ? options.quiz : argv.quiz;
    const noQuiz = options.noQuiz !== undefined ? options.noQuiz : argv.noQuiz;
    const limit = options.limit !== undefined ? options.limit : argv.limit;
    // 「设为当前」生效：设了当前课程就只跑那一门，没设置跑全部；
    // CLI 显式传课程列表（options.courses）时按参数走，不筛
    let courses = (options.courses && options.courses.length) ? options.courses : getCourses();
    if (!options.courses && settings.ACTIVE_COURSE) {
        const hit = courses.filter(c => c.courseKey === settings.ACTIVE_COURSE);
        if (hit.length > 0) courses = hit;
        else log(`⚠️ 当前课程 ${settings.ACTIVE_COURSE} 不在课程列表里，按全部课程跑`);
    }
    // GUI 下由演练开关驱动 opts.submit（非 --submit），非演练才走到 submitQuiz 内的确认钩子
    const drill = options.drill === true;
    const cliSubmit = options.submit !== undefined ? options.submit : argv.submit;
    const quizSubmit = isGui ? !drill : cliSubmit;
    const learnSubmit = isGui ? !drill : true;
    const log = createLogger('[icourse163]', 0);

    log(`📝 运行日志：${logFile}`);

    // 开了 DeepSeek 却没填 Key 时给一句明确提示，免得用户以为它在工作
    // 开了答题模型却没配 Key 时给一句明确提示，免得用户以为它在工作
    if (settings.LLM_ENABLED && !settings.LLM_API_KEY) {
        log('⚠️ 已启用答题模型但没填 API Key，答题会跳过这一层；到「设置 → 配置模型」填好后生效');
    }

    // 脚本自己的 profile 还没有登录态时，先试着复用本机 Edge 的登录
    prepareProfile(PROFILE_DIR, log);

    const { context, page } = await launchBrowser();

    try {
        ctx.emit('state', { phase: 'login', label: '检查登录', running: true, paused: false });
        if (!await ensureLoggedIn(page, log)) {
            console.error('❌ 未完成登录，退出');
            await context.close();
            return;
        }
        // 登录确认后写标记，记录页据此判断登录态；清空登录态时随目录一起备份/删除
        try { fs.writeFileSync(path.join(PROFILE_DIR, '.logged-in'), new Date().toISOString()); } catch {}

        // 后台模式（默认）：登录确认后把课程浏览器最小化，之后搜索开新标签也自动重新
        // 最小化、不再抢前台；扫码期间保持可见（二维码要用户扫），probe 模式保持可见
        const courseBrowserMode = require('../../core/prefs').getPrefs().courseBrowserMode;
        if (courseBrowserMode === 'minimized' && !probeMode) {
            const { minimizeBrowser } = require('./browser');
            minimizeBrowser(context);
            context.on('page', () => minimizeBrowser(context));
            log('🫥 课程浏览器已在后台最小化运行（任务栏可点开查看），需要观察时手动还原即可');
        }

        const runs = [];

        for (const course of courses) {
            // 切课时「本场不再提示」缓存失效
            if (typeof ctx.resetSkipConfirm === 'function') ctx.resetSkipConfirm();

            if (probeMode) {
                await probeCourse(page, course, log);
            } else if (quizMode) {
                const { runQuizzes } = require('./quiz');
                const quiz = await runQuizzes(page, course, log, { submit: quizSubmit, limit, ctx });
                runs.push({ course, quiz });
            } else {
                const learn = await learnCourse(page, course, log, { drill, limit });

                // 一键完成：视频和课件跑完接着把测验也做掉
                let quiz = null;
                if (!noQuiz) {
                    log('\n📝 开始处理章节测验...');
                    const { runQuizzes } = require('./quiz');
                    quiz = await runQuizzes(page, course, log, { submit: learnSubmit, limit: limit || 0, ctx });
                } else {
                    log('\n💡 已跳过测验（--no-quiz）。要做测验去掉这个参数，或单独跑 --quiz');
                }
                runs.push({ course, learn, quiz });
            }
        }

        // 跑了两三个小时，最后给个总账，不用翻几百行日志
        if (runs.length > 0) {
            log('');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log('  本次运行汇总');
            for (const r of runs) {
                log(`  课程 ${r.course.courseKey}`);
                if (r.learn) {
                    log(`    任务点   本轮完成 ${r.learn.done} 个，累计 ${r.learn.learned}/${r.learn.total}`);
                    if (r.learn.pending) log(`    待处理   还有 ${r.learn.pending} 个，见上方收尾检查`);
                }
                if (r.quiz) {
                    const bits = [`提交 ${r.quiz.submitted}`];
                    if (r.quiz.skipped) bits.push(`跳过 ${r.quiz.skipped}`);
                    if (r.quiz.unreadScore) bits.push(`${r.quiz.unreadScore} 场未读到分`);
                    const scorePart = r.quiz.score ? `，累计得分 ${r.quiz.score}` : '';
                    log(`    测验     ${bits.join('，')}（待做 ${r.quiz.todo} 个）${scorePart}`);
                }
            }
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        // Summary 由 runs[] 旁路组装，不反解析上面的汇总文本
        const totals = { tasksDone: 0, tasksFailed: 0, quizzesSubmitted: 0, score: 0 };
        for (const r of runs) {
            if (r.learn) {
                totals.tasksDone += r.learn.done || 0;
                totals.tasksFailed += r.learn.pending || 0;
            }
            if (r.quiz) {
                totals.quizzesSubmitted += r.quiz.submitted || 0;
                totals.score += r.quiz.score || 0;
            }
        }
        ctx.emit('state', { phase: 'summary', label: '汇总', running: true, paused: false });
        ctx.emit('summary', { runs, totals });

        log('🏁 全部课程处理完毕，浏览器保持打开，可手动关闭');
        ctx.emit('state', { phase: 'done', label: '已完成', running: false, paused: false });
        if (probeMode) await context.close();
    } catch (e) {
        console.error('❌ 运行出错:', e.message);
        // GUI 下把异常交给上层的异常分类（断网 / 浏览器被关）；CLI 保持原样吞掉
        if (ctx.mode === 'gui') throw e;
    } finally {
        // 每次 run 结束复原 console，GUI 常驻多次 run 不会叠加劫持链
        restore();
    }
}

module.exports = { run };
