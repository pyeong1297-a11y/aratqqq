/**
 * 익절 간격 시나리오 비교 스크립트
 * 실행: node --experimental-vm-modules scripts/compare_profits.mjs
 */


const BASE_TICKERS = ['TQQQ', 'SPYM', 'SGOV'];
const START = '2016-01-01';
const END = '2026-01-01';
const INITIAL_CAPITAL = 10000;
const MONTHLY = 0;

async function fetchYahoo(ticker, start, end) {
    const s = Math.floor(new Date(start).getTime() / 1000);
    const e = Math.floor(new Date(end).getTime() / 1000);
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${s}&period2=${e}&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`${ticker} fetch failed: ${res.status}`);
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) throw new Error(`${ticker}: no data`);
    const ts = result.timestamp;
    const close = result.indicators.quote[0].close;
    const open = result.indicators.quote[0].open;
    const low = result.indicators.quote[0].low;
    return ts.map((t, i) => ({ date: new Date(t * 1000), close: close[i], open: open[i], low: low[i] })).filter(r => r.close != null);
}

async function prepareData() {
    process.stdout.write('데이터 다운로드 중');
    const spymFallback = 'SPLG';
    const sgovFallback = 'BIL';

    const [tqqq, rawSpym, rawSgov] = await Promise.all([
        fetchYahoo('TQQQ', START, END),
        fetchYahoo('SPYM', START, END).catch(() => fetchYahoo(spymFallback, START, END)),
        fetchYahoo('SGOV', START, END).catch(() => fetchYahoo(sgovFallback, START, END)),
    ]);

    const spymMap = new Map(rawSpym.map(r => [r.date.toISOString().slice(0, 10), r.close]));
    const sgovMap = new Map(rawSgov.map(r => [r.date.toISOString().slice(0, 10), r.close]));

    // MA200
    const closes = tqqq.map(r => r.close);
    const rows = tqqq.map((r, i) => {
        const ds = r.date.toISOString().slice(0, 10);
        const ma200 = i >= 199 ? closes.slice(i - 199, i + 1).reduce((a, b) => a + b, 0) / 200 : 0;
        return {
            date: r.date,
            dateStr: ds,
            TQQQ: r.close,
            leverOpen: r.open,
            leverLow: r.low,
            SPYM: spymMap.get(ds) || r.close,
            SGOV: sgovMap.get(ds) || 1.0,
            ma200,
        };
    });
    process.stdout.write(' ✓\n');
    return rows;
}

// ── 간소화된 백테스터 ─────────────────────────────────────────────────────────

const FEE = 0.0025;
const MC = { INVEST: '집중투자', OVERHEAT: '과열', DECLINE: '하락' };

function condition(price, ma200) {
    if (ma200 <= 0) return MC.DECLINE;
    if (price > ma200 * 1.01) return MC.INVEST;
    if (price > ma200 * 0.95) return MC.OVERHEAT;
    return MC.DECLINE;
}

function runBacktest(data, { profitStart, profitSpacing, profitRatio, label, earlyProfits = [] }) {
    let cash = INITIAL_CAPITAL, leverSh = 0, leverAvg = 0, lastMilestone = 0, nextEarlyIdx = 0;
    let spymSh = 0, spymAvg = 0, sgovSh = 0;
    let prevCond = null, waitConfirm = false;
    let lastMonth = `${data[0].date.getFullYear()}-${data[0].date.getMonth()}`;
    let contributed = INITIAL_CAPITAL;
    const values = [];

    for (let i = 0; i < data.length; i++) {
        const r = data[i];
        const lp = r.TQQQ, sp = r.SPYM, gp = r.SGOV;
        const cond = condition(lp, r.ma200);
        const ym = `${r.date.getFullYear()}-${r.date.getMonth()}`;
        if (ym !== lastMonth && MONTHLY > 0 && r.date.getDate() >= 21) {
            cash += MONTHLY; contributed += MONTHLY; lastMonth = ym;
        } else if (i === 0) { lastMonth = ym; }

        // 가짜돌파
        if (prevCond === MC.DECLINE && cond === MC.INVEST) waitConfirm = true;
        else if (cond === MC.INVEST && prevCond === MC.INVEST) waitConfirm = false;
        else if (cond !== MC.INVEST) waitConfirm = false;

        // 스탑로스 -5%
        if (leverSh > 0 && leverAvg > 0) {
            const openP = r.leverOpen || lp, lowP = r.leverLow || lp;
            const slThresh = leverAvg * 0.95;
            if (openP < slThresh) {
                cash += leverSh * openP * (1 - FEE); leverSh = 0; leverAvg = 0; lastMilestone = 0; nextEarlyIdx = 0;
                cash += spymSh * sp * (1 - FEE); spymSh = 0; spymAvg = 0;
                sgovSh += cash / gp * (1 - FEE); cash = 0;
            } else if (lowP < slThresh) {
                cash += leverSh * slThresh * (1 - FEE); leverSh = 0; leverAvg = 0; lastMilestone = 0; nextEarlyIdx = 0;
                cash += spymSh * sp * (1 - FEE); spymSh = 0; spymAvg = 0;
                sgovSh += cash / gp * (1 - FEE); cash = 0;
            }
        }

        // 익절 체크
        if (leverSh > 0 && leverAvg > 0) {
            const rate = (lp - leverAvg) / leverAvg * 100;

            // 조기 소액 익절 (10%, 50% 등)
            while (nextEarlyIdx < earlyProfits.length && rate >= earlyProfits[nextEarlyIdx].t) {
                const ep = earlyProfits[nextEarlyIdx];
                const sellSh = leverSh * ep.r;
                const proceeds = sellSh * lp * (1 - FEE);
                leverSh -= sellSh;
                if (leverSh <= 0.0001) { leverSh = 0; leverAvg = 0; lastMilestone = 0; }
                const totalCost = spymSh * spymAvg + proceeds;
                spymSh += proceeds / sp * (1 - FEE);
                if (spymSh > 0) spymAvg = totalCost / spymSh;

                nextEarlyIdx++;
            }

            // 기본 마일스톤 익절
            if (rate >= profitStart) {
                const ms = Math.floor((rate - profitStart) / profitSpacing) * profitSpacing + profitStart;
                if (ms >= profitStart && ms > lastMilestone) {
                    const sellSh = leverSh * profitRatio;
                    const proceeds = sellSh * lp * (1 - FEE);
                    leverSh -= sellSh;
                    if (leverSh <= 0.0001) { leverSh = 0; leverAvg = 0; }
                    const totalCost = spymSh * spymAvg + proceeds;
                    spymSh += proceeds / sp * (1 - FEE);
                    if (spymSh > 0) spymAvg = totalCost / spymSh;
                    lastMilestone = ms;
                }
            }
        }

        // 시장 조건별 매매
        if (cond === MC.DECLINE) {
            if (leverSh > 0 || spymSh > 0) {
                cash += leverSh * lp * (1 - FEE) + spymSh * sp * (1 - FEE);
                leverSh = 0; leverAvg = 0; spymSh = 0; spymAvg = 0; lastMilestone = 0; nextEarlyIdx = 0;
                sgovSh += cash / gp * (1 - FEE); cash = 0;
            } else if (cash > 0) {
                sgovSh += cash / gp * (1 - FEE); cash = 0;
            }
        } else if (cond === MC.INVEST) {
            if (sgovSh > 0 && !waitConfirm) {
                cash += sgovSh * gp * (1 - FEE); sgovSh = 0;
                const sh = cash / lp * (1 - FEE);
                const tc = leverSh * leverAvg + cash;
                leverSh += sh; leverAvg = leverSh > 0 ? tc / leverSh : 0; cash = 0;
            } else if (cash > 0 && !waitConfirm) {
                const sh = cash / lp * (1 - FEE);
                const tc = leverSh * leverAvg + cash;
                leverSh += sh; leverAvg = leverSh > 0 ? tc / leverSh : lp; cash = 0;
            }
        } else { // OVERHEAT
            if (cash > 0) {
                const sh = cash / sp * (1 - FEE);
                const tc = spymSh * spymAvg + cash;
                spymSh += sh; spymAvg = spymSh > 0 ? tc / spymSh : sp; cash = 0;
            }
        }

        values.push(cash + leverSh * lp + spymSh * sp + sgovSh * gp);
        prevCond = cond;
    }

    const final = values[values.length - 1];
    const years = (data[data.length - 1].date - data[0].date) / (365.25 * 864e5);
    const cagr = years > 0 ? ((final / contributed) ** (1 / years) - 1) * 100 : 0;
    let runMax = values[0], mdd = 0;
    for (const v of values) {
        if (v > runMax) runMax = v;
        const dd = (v - runMax) / runMax * 100;
        if (dd < mdd) mdd = dd;
    }
    return {
        label,
        final: Math.round(final),
        ret: ((final - contributed) / contributed * 100).toFixed(1),
        cagr: cagr.toFixed(1),
        mdd: mdd.toFixed(1),
    };
}

// ── 시나리오 정의 ─────────────────────────────────────────────────────────────

const scenarios = [
    { label: '◾ 기본 (100%에 50% 익절)', profitStart: 100, profitSpacing: 100, profitRatio: 0.50 },
    { label: '🟢 단발 (100%에 75% 익절)', profitStart: 100, profitSpacing: 9999, profitRatio: 0.75 },
    { label: '🟣 조기1 (10%, 50%) + 기본', profitStart: 100, profitSpacing: 100, profitRatio: 0.50, earlyProfits: [{ t: 10, r: 0.1 }, { t: 50, r: 0.1 }] },
    { label: '🟤 조기1 (10%, 50%) + 단발', profitStart: 100, profitSpacing: 9999, profitRatio: 0.75, earlyProfits: [{ t: 10, r: 0.1 }, { t: 50, r: 0.1 }] },
    { label: '🔵 조기2 (20%, 60%) + 기본', profitStart: 100, profitSpacing: 100, profitRatio: 0.50, earlyProfits: [{ t: 20, r: 0.1 }, { t: 60, r: 0.1 }] },
];

// ── 실행 ──────────────────────────────────────────────────────────────────────

(async () => {
    const data = await prepareData();
    console.log(`\n📊 TQQQ 조기 익절 시나리오 비교 (${data[0].dateStr} ~ ${data[data.length - 1].dateStr})\n`);
    console.log('시나리오' + ' '.repeat(35) + '최종자산     수익률    CAGR    MDD');
    console.log('─'.repeat(85));

    for (const s of scenarios) {
        const r = runBacktest(data, s);
        const labelPad = r.label.padEnd(42);
        console.log(`${labelPad}$${String(r.final).padStart(9)}  ${String(r.ret + '%').padStart(8)}  ${String(r.cagr + '%').padStart(7)}  ${String(r.mdd + '%').padStart(7)}`);
    }
    console.log('─'.repeat(85));
    console.log('* 초기투자 $10,000 / 월적립금 없음 / 스탑로스 5% 적용');
})();
