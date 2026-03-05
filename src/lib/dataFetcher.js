/**
 * 데이터 수집 모듈 - Yahoo Finance API + 엑셀 일별데이터
 * aratqqq2 전략 기반 2구간 버전
 * Server-side only (Next.js API Route 내에서 사용)
 */

// 야후 파이낸스 v8 API
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

export const TICKER_EARLIEST_DATE = {
    TQQQ: '2010-02-11',
    BITU: '2022-06-22',
    SOLT: '2024-02-22',
    ETHU: '2022-10-04',
    BULZ: '2021-08-18',
    'BTC-USD': '2014-09-17',
    'ETH-USD': '2017-11-09',
};

export const TICKER_DESCRIPTIONS = {
    TQQQ: '나스닥 100 3배 레버리지',
    BITU: '비트코인 2배 레버리지',
    SOLT: '솔라나 2배 레버리지',
    ETHU: '이더리움 2배 레버리지',
    BULZ: '미국 혁신기업15 3배 (BULZ)',
};

export const SAFE_ASSET = 'SGOV';
export const PROFIT_ASSET = 'SPYM';
export const BENCHMARK_TICKERS = ['QQQ', 'QLD', 'TQQQ'];

/**
 * Yahoo Finance에서 일별 OHLCV 데이터를 가져옴
 */
export async function fetchYahooData(ticker, startDate, endDate) {
    const t1 = Math.floor(new Date(startDate).getTime() / 1000);
    const t2 = Math.floor(new Date(endDate).getTime() / 1000);

    const url = `${YF_BASE}/${encodeURIComponent(ticker)}?period1=${t1}&period2=${t2}&interval=1d&events=history&includeAdjustedClose=true`;

    const headers = {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
    };

    const res = await fetch(url, { headers, next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`Yahoo Finance fetch failed: ${ticker} (${res.status})`);

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`No data for ${ticker}`);

    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose || quotes.close;

    const dates = timestamps.map(t => new Date(t * 1000));
    const open = quotes.open || [];
    const high = quotes.high || [];
    const low = quotes.low || [];
    const close = quotes.close || [];

    return { dates, open, high, low, close, adjClose: adjClose || close };
}

/**
 * 여러 티커의 종가 데이터를 날짜를 키로 하는 Map으로 정렬·병합
 */
export async function fetchPrices(tickers, startDate, endDate, warmupDays = 400) {
    const extStart = new Date(startDate);
    extStart.setDate(extStart.getDate() - warmupDays);
    const extStartStr = extStart.toISOString().split('T')[0];

    const results = await Promise.allSettled(
        tickers.map(t => fetchYahooData(t, extStartStr, endDate).then(d => ({ ticker: t, data: d })))
    );

    const pricesByDate = new Map();

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('Ticker fetch failed:', r.reason);
            continue;
        }
        const { ticker, data } = r.value;
        const { dates, adjClose, open, high, low } = data;

        for (let i = 0; i < dates.length; i++) {
            const dateStr = dates[i].toISOString().split('T')[0];
            if (!pricesByDate.has(dateStr)) pricesByDate.set(dateStr, {});
            const entry = pricesByDate.get(dateStr);

            const price = adjClose[i];
            if (price != null && !isNaN(price) && price > 0) {
                entry[ticker] = price;
                if (open[i] != null) entry[`${ticker}_open`] = open[i];
                if (high[i] != null) entry[`${ticker}_high`] = high[i];
                if (low[i] != null) entry[`${ticker}_low`] = low[i];
            }
        }
    }

    return pricesByDate;
}

/**
 * 백테스트용 데이터 배열 준비
 * @returns {Promise<Array<{date, [ticker], SGOV, SPYM, ma200, leverATH, leverDD, leverOpen, leverLow}>>}
 */
export async function prepareBacktestData(leverTicker, startDate, endDate, maPeriod = 200) {
    // 상장일 하한 적용
    const earliest = TICKER_EARLIEST_DATE[leverTicker];
    const adjStart = earliest && earliest > startDate ? earliest : startDate;

    const allTickers = [...new Set([leverTicker, SAFE_ASSET, PROFIT_ASSET, 'BIL', ...BENCHMARK_TICKERS])];
    const pricesByDate = await fetchPrices(allTickers, adjStart, endDate, maPeriod * 2);

    const allDates = Array.from(pricesByDate.keys()).sort();

    const rows = [];
    const closePrices = [];

    for (const dateStr of allDates) {
        const entry = pricesByDate.get(dateStr);
        const leverPrice = entry[leverTicker];
        if (leverPrice == null) continue;

        // 주식 시장 개장일 기준 (SPYM/SGOV/BIL/QQQ 중 하나라도 있으면 개장일)
        const isStockMarketOpen = entry[PROFIT_ASSET] || entry[SAFE_ASSET] || entry['BIL'] || entry['QQQ'];
        if (!isStockMarketOpen && dateStr < endDate) continue;

        closePrices.push(leverPrice);
        const ma200 = closePrices.length >= maPeriod
            ? closePrices.slice(-maPeriod).reduce((a, b) => a + b, 0) / maPeriod
            : 0;

        // ATH 및 Drawdown
        const prevATH = rows.length > 0 ? rows[rows.length - 1].leverATH : leverPrice;
        const leverATH = Math.max(prevATH, leverPrice);
        const leverDD = (leverPrice / leverATH - 1) * 100;

        // SGOV 보완
        let sgovPrice = entry[SAFE_ASSET] ?? entry['BIL'] ?? null;

        rows.push({
            date: new Date(dateStr + 'T12:00:00Z'),
            dateStr,
            [leverTicker]: leverPrice,
            SGOV: sgovPrice,
            SPYM: entry[PROFIT_ASSET] ?? null,
            ...BENCHMARK_TICKERS.reduce((acc, t) => (entry[t] ? { ...acc, [t]: entry[t] } : acc), {}),
            ma200,
            leverATH,
            leverDD,
            leverOpen: entry[`${leverTicker}_open`] ?? leverPrice,
            leverHigh: entry[`${leverTicker}_high`] ?? Math.max(leverPrice, entry[`${leverTicker}_open`] ?? leverPrice),
            leverLow: entry[`${leverTicker}_low`] ?? leverPrice,
        });
    }

    // SGOV null 구간 forward/backward fill
    const firstValidSgov = rows.find(r => r.SGOV != null)?.SGOV || 1.0;
    let lastSgov = firstValidSgov;
    for (const row of rows) {
        if (row.SGOV != null) { lastSgov = row.SGOV; }
        else { row.SGOV = lastSgov; }
        if (row.SPYM == null) { row.SPYM = row[leverTicker]; }
    }

    return rows.filter(r => r.dateStr >= adjStart);
}

export function getAvailableTickers() {
    return Object.entries(TICKER_EARLIEST_DATE).map(([ticker, earliest_date]) => ({
        ticker,
        description: TICKER_DESCRIPTIONS[ticker] || ticker,
        earliest_date,
    }));
}
