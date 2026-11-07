// 结构化事件中枢。业务层只调 emit()，界面通过 SSE 订阅。
// 关窗期间事件继续写环形缓冲，重新连接时按 Last-Event-ID 补发。
function createBus(capacity = 800) {
    let seq = 0;
    const ring = [];
    const subs = new Set();

    function write(res, evt) {
        try {
            res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
        } catch {
            subs.delete(res);
        }
    }

    function emit(type, payload = {}) {
        const evt = {
            id: ++seq,
            type,
            ts: new Date().toISOString(),
            ...payload
        };
        ring.push(evt);
        if (ring.length > capacity) ring.shift();
        for (const res of subs) write(res, evt);
        return evt;
    }

    function history(afterId = 0) {
        const n = Number(afterId) || 0;
        return ring.filter(e => e.id > n);
    }

    function subscribeSSE(res, lastId = 0) {
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
        });
        res.write(': connected\n\n');

        for (const evt of history(lastId)) write(res, evt);
        subs.add(res);

        return () => subs.delete(res);
    }

    function closeAll() {
        for (const res of subs) {
            try { res.end(); } catch {}
        }
        subs.clear();
    }

    function heartbeat() {
        for (const res of subs) {
            try { res.write(': ping\n\n'); } catch { subs.delete(res); }
        }
    }

    return { emit, history, subscribeSSE, closeAll, heartbeat, size: () => ring.length };
}

module.exports = { createBus };
