import { NextResponse } from 'next/server';
import { prepareBacktestData, BENCHMARK_TICKERS } from '@/lib/dataFetcher';
import { Backtester, calculateBenchmark } from '@/lib/backtester';

export async function POST(req) {
    try {
        const body = await req.json().catch(() => ({}));

        const leverTicker = (body.lever_ticker || 'TQQQ').toUpperCase();
        const initialCapital = parseFloat(body.initial_capital ?? 10000);
        const monthlyContribution = parseFloat(body.monthly_contribution ?? 0);
        const startDate = body.start_date || '2016-01-01';
        const endDate = body.end_date || '2026-01-01';
        const profitTaking = body.profit_taking !== false;
        const profitStart = parseFloat(body.profit_start ?? 100);
        const profitRatio = parseFloat(body.profit_ratio ?? 50) / 100;
        const profitSpacing = parseFloat(body.profit_spacing ?? 100);
        const stoplostPct = parseFloat(body.stoploss_pct ?? 5) / 100;
        const confirmCross = body.confirm_cross !== false;

        // 데이터 준비
        const data = await prepareBacktestData(leverTicker, startDate, endDate);
        if (!data || data.length === 0) {
            return NextResponse.json({ error: '데이터 없음. 기간 또는 티커를 확인하세요.' }, { status: 400 });
        }

        // 백테스트 실행
        const bt = new Backtester({
            data, leverTicker, initialCapital, monthlyContribution,
            profitTaking, profitStart, profitRatio, profitSpacing,
            stoplostPct, confirmCross,
        });
        const result = bt.run();
        if (!result) return NextResponse.json({ error: '백테스트 실패' }, { status: 500 });

        const { finalValue, totalContributed, totalReturn, cagr, mdd, portfolioValues, trades } = result;

        // 벤치마크 계산
        const benchmarks = {};
        const bmCandidates = [...new Set([...BENCHMARK_TICKERS, leverTicker])];
        for (const ticker of bmCandidates) {
            if (data.some(r => r[ticker] != null)) {
                const bm = calculateBenchmark(data, ticker, initialCapital, monthlyContribution);
                if (bm.length > 0) {
                    const finalBmVal = bm[bm.length - 1].value;
                    benchmarks[ticker] = {
                        values: bm.map(b => ({ dateStr: b.dateStr, value: b.value })),
                        final_value: finalBmVal,
                        total_return: totalContributed ? (finalBmVal - totalContributed) / totalContributed * 100 : 0,
                    };
                }
            }
        }

        // 차트 데이터 직렬화
        const chartData = {
            dates: portfolioValues.map(v => v.dateStr),
            strategyValues: portfolioValues.map(v => v.totalValue),
            leverPrices: portfolioValues.map(v => v.leverPrice),
            ma200: portfolioValues.map(v => v.ma200),
            benchmarks: Object.fromEntries(
                Object.entries(benchmarks).map(([t, bm]) => [t, bm.values.map(v => v.value)])
            ),
        };

        // 거래내역 직렬화 (레이블 간소화)
        const tradesList = trades.map(t => {
            let label = null;
            const action = t.action || '';
            if (action.includes('익절')) {
                try {
                    const pctStr = action.split('+')[1].split('%')[0];
                    const multiple = Math.floor(parseFloat(pctStr) / 100);
                    label = `${multiple}배`;
                } catch { label = '익절'; }
            } else if (action.includes('스탑로스')) { label = 'S'; }
            else if (action.includes('하락신호')) { label = 'M'; }
            else if (action.includes('부정입학')) { label = 'B'; }
            else if (action.includes('집중투자') && action.includes('SGOV')) { label = 'B'; }

            return {
                date: t.dateStr,
                action: t.action,
                condition: t.condition,
                total_value: Math.round(t.totalValue * 100) / 100,
                gain: Math.round(t.gain * 100) / 100,
                gain_pct: Math.round(t.gainPct * 100) / 100,
                chart_label: label,
            };
        });

        return NextResponse.json({
            lever_ticker: leverTicker,
            result: {
                final_value: Math.round(finalValue * 100) / 100,
                total_contributed: Math.round(totalContributed * 100) / 100,
                total_return: Math.round(totalReturn * 100) / 100,
                cagr: Math.round(cagr * 100) / 100,
                mdd: Math.round(mdd * 100) / 100,
                trades_count: tradesList.length,
            },
            benchmarks: Object.fromEntries(
                Object.entries(benchmarks).map(([t, bm]) => [t, {
                    final_value: Math.round(bm.final_value * 100) / 100,
                    total_return: Math.round(bm.total_return * 100) / 100,
                }])
            ),
            chart_data: chartData,
            trades: tradesList,
            data_period: `${data[0].dateStr} ~ ${data[data.length - 1].dateStr}`,
            trading_days: data.length,
        });

    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
