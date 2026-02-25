'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
    Chart, CategoryScale, LinearScale, TimeScale,
    PointElement, LineElement, Title, Tooltip, Legend,
    Filler, ScatterController, LineController
} from 'chart.js';
import 'chartjs-adapter-date-fns';

Chart.register(
    CategoryScale, LinearScale, TimeScale,
    PointElement, LineElement, Title, Tooltip, Legend,
    Filler, ScatterController, LineController
);

const TICKERS_STATIC = [
    { ticker: 'TQQQ', description: '나스닥 100 3배 레버리지', earliest_date: '2010-02-11' },
    { ticker: 'BITU', description: '비트코인 2배 레버리지', earliest_date: '2022-06-22' },
    { ticker: 'SOLT', description: '솔라나 2배 레버리지', earliest_date: '2024-02-22' },
    { ticker: 'ETHU', description: '이더리움 2배 레버리지', earliest_date: '2022-10-04' },
    { ticker: 'BULZ', description: '혁신기업15 3배 레버리지', earliest_date: '2021-08-18' },
];

const fmt = (v, decimals = 2) =>
    v == null ? '-' : v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export default function HomePage() {
    const [selectedTicker, setSelectedTicker] = useState('TQQQ');
    const [customTicker, setCustomTicker] = useState('');
    const [form, setForm] = useState({
        start_date: '2016-01-01',
        end_date: '2026-01-01',
        initial_capital: 10000,
        monthly_contribution: 0,
        confirm_cross: true,
        stoploss_pct: 5,
        profit_taking: true,
        profit_start: 100,
        profit_ratio: 50,
        profit_spacing: 100,
        dip_buy_enabled: false,
        dip_buy_thresholds: '-50,-60,-70',
        dip_buy_allocations: '33,33,34',
    });

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    const [trades, setTrades] = useState([]);
    const [filter, setFilter] = useState('');
    const [dipOpen, setDipOpen] = useState(false);

    const portfolioChartRef = useRef(null);
    const priceChartRef = useRef(null);
    const portfolioChart = useRef(null);
    const priceChart = useRef(null);

    const activeTicker = customTicker || selectedTicker;

    function setField(key, val) {
        setForm(f => ({ ...f, [key]: val }));
    }


    useEffect(() => {
        if (result && !loading) {
            renderCharts(result);
        }
    }, [result, loading]);

    async function runBacktest() {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/backtest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...form, lever_ticker: activeTicker }),
            });
            const data = await res.json();
            if (data.error) { setError(data.error); return; }
            setResult(data);
            setTrades(data.trades || []);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }

    function renderCharts(data) {
        const { chart_data, trades: tradesList } = data;
        if (!chart_data) return;

        const labels = chart_data.dates;

        // ── 포트폴리오 가치 차트 ─────────────────────────────────────────
        if (portfolioChart.current) portfolioChart.current.destroy();

        const bm_styles = {
            QQQ: { color: '#6e7681', bw: 1.2 },
            QLD: { color: '#c9a227', bw: 1.2 },
            TQQQ: { color: '#e67e22', bw: 1.4 },
        };

        const bmDatasets = Object.entries(chart_data.benchmarks || {}).map(([ticker, values]) => ({
            label: ticker,
            data: values,
            borderColor: bm_styles[ticker]?.color || '#f39c12',
            borderWidth: bm_styles[ticker]?.bw || 1.2,
            pointRadius: 0,
            tension: 0.2,
        }));

        portfolioChart.current = new Chart(portfolioChartRef.current, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    ...bmDatasets,
                    {
                        label: 'ARA 전략',
                        data: chart_data.strategyValues,
                        borderColor: '#00d4aa',
                        borderWidth: 2.5,
                        pointRadius: 0,
                        tension: 0.2,
                        fill: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { labels: { color: '#8b949e', font: { size: 11 } } },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: $${fmt(ctx.parsed.y, 0)}`,
                        },
                    },
                },
                scales: {
                    x: { ticks: { color: '#8b949e', maxTicksLimit: 10 }, grid: { color: '#30363d22' } },
                    y: {
                        ticks: {
                            color: '#8b949e',
                            callback: v => `$${v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v}`,
                        },
                        grid: { color: '#30363d22' },
                    },
                },
            },
        });

        // ── 가격 + MA200 + 이벤트 차트 ──────────────────────────────────
        if (priceChart.current) priceChart.current.destroy();

        // 이벤트 포인트 (익절, 매수, 매도, 스탑)
        const eventColors = { 'B': '#00d4aa', 'S': '#ff4444', 'M': '#ff7777', '익절': '#ffd700' };
        const eventsDataset = {
            type: 'scatter',
            label: '이벤트',
            data: (tradesList || [])
                .filter(t => t.chart_label)
                .map(t => {
                    const idx = labels.indexOf(t.date);
                    return idx >= 0 ? {
                        x: t.date,
                        y: chart_data.leverPrices[idx],
                        label: t.chart_label,
                    } : null;
                })
                .filter(Boolean),
            pointRadius: 7,
            pointStyle: 'circle',
            backgroundColor: ctx => {
                const d = ctx.raw;
                if (!d) return '#aaa';
                if (d.label?.includes('배')) return '#ffd700dd';
                if (d.label === 'B') return '#00d4aaaa';
                if (d.label === 'S') return '#ff4444aa';
                if (d.label === 'M') return '#ff7777aa';
                return '#ffffffaa';
            },
        };

        priceChart.current = new Chart(priceChartRef.current, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: `${data.lever_ticker} 가격`,
                        data: chart_data.leverPrices,
                        borderColor: '#58a6ff',
                        borderWidth: 1.4,
                        pointRadius: 0,
                        tension: 0.1,
                    },
                    {
                        label: 'MA200',
                        data: chart_data.ma200.map(v => v > 0 ? v : null),
                        borderColor: '#ff9500',
                        borderWidth: 1.8,
                        borderDash: [4, 3],
                        pointRadius: 0,
                        tension: 0.1,
                    },
                    eventsDataset,
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { labels: { color: '#8b949e', font: { size: 11 } } },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                if (ctx.dataset.type === 'scatter' && ctx.raw?.label) {
                                    return `${ctx.raw.label}: $${fmt(ctx.raw.y, 2)}`;
                                }
                                return `${ctx.dataset.label}: $${fmt(ctx.parsed.y, 2)}`;
                            },
                        },
                    },
                },
                scales: {
                    x: { ticks: { color: '#8b949e', maxTicksLimit: 10 }, grid: { color: '#30363d22' } },
                    y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d22' } },
                },
            },
        });
    }

    const filteredTrades = trades.filter(t =>
        !filter || t.action?.toLowerCase().includes(filter.toLowerCase()) || t.date?.includes(filter)
    );

    const conditionTag = (c) => {
        if (c === '하락') return <span style={{ background: 'rgba(255,107,107,.15)', color: '#ff6b6b', padding: '1px 7px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 600 }}>{c}</span>;
        if (c === '집중투자') return <span style={{ background: 'rgba(77,255,136,.12)', color: '#4dff88', padding: '1px 7px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 600 }}>{c}</span>;
        return <span style={{ background: 'rgba(255,215,0,.12)', color: '#ffd700', padding: '1px 7px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 600 }}>{c}</span>;
    };

    return (
        <>
            {/* Loading */}
            {loading && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,.8)', zIndex: 999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
                    <div style={{ width: 48, height: 48, border: '4px solid #30363d', borderTopColor: '#00d4aa', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
                    <div style={{ color: '#00d4aa', fontSize: '0.9rem' }}>백테스트 실행 중… (데이터 다운로드 포함)</div>
                </div>
            )}
            {error && (
                <div style={{ position: 'fixed', bottom: 30, right: 30, background: '#2d1b1b', border: '1px solid #ff6b6b', color: '#ff6b6b', padding: '12px 20px', borderRadius: 8, zIndex: 1000, maxWidth: 360 }}>
                    ⚠️ {error}
                    <button onClick={() => setError('')} style={{ marginLeft: 12, background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer' }}>✕</button>
                </div>
            )}

            <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d1117; color: #e6edf3; font-family: 'Inter','Malgun Gothic',sans-serif; }
        input, select { background:#21262d; border:1px solid #30363d; border-radius:6px; color:#e6edf3; font-size:.875rem; padding:7px 10px; outline:none; width:100%; transition:border-color .2s; }
        input:focus, select:focus { border-color:#00d4aa; }
        label { font-size:.78rem; color:#8b949e; margin-bottom:3px; display:block; }
      `}</style>

            {/* Header */}
            <header style={{ background: 'linear-gradient(135deg,#161b22,#0d1117)', borderBottom: '1px solid #30363d', padding: '18px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ fontSize: '2rem' }}>📈</span>
                <div>
                    <h1 style={{ fontSize: '1.35rem', fontWeight: 700, color: '#00d4aa' }}>ARA Backtester</h1>
                    <p style={{ fontSize: '0.8rem', color: '#8b949e', marginTop: 2 }}>레버리지 ETF 200일선 투자법 — 집중투자 · 배수익절 · 딥바잉</p>
                </div>
            </header>

            <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 14, padding: '14px 20px 40px', maxWidth: 1700, margin: '0 auto' }}>

                {/* ══ 사이드바 ══════════════════════════════════════════════ */}
                <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                    {/* 티커 선택 */}
                    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 16 }}>
                        <div style={{ fontSize: '.76rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#8b949e', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #30363d' }}>📌 레버리지 ETF 선택</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                            {TICKERS_STATIC.map(t => (
                                <div
                                    key={t.ticker}
                                    onClick={() => { setSelectedTicker(t.ticker); setCustomTicker(''); }}
                                    style={{
                                        background: (activeTicker === t.ticker && !customTicker) ? 'rgba(0,212,170,.08)' : '#21262d',
                                        border: `2px solid ${(activeTicker === t.ticker && !customTicker) ? '#00d4aa' : '#30363d'}`,
                                        borderRadius: 8, padding: '10px 8px', cursor: 'pointer', textAlign: 'center', transition: 'all .15s'
                                    }}
                                >
                                    <div style={{ fontSize: '1rem', fontWeight: 700, color: '#00d4aa', fontFamily: 'monospace' }}>{t.ticker}</div>
                                    <div style={{ fontSize: '.67rem', color: '#8b949e', marginTop: 2 }}>{t.description}</div>
                                    <div style={{ fontSize: '.63rem', color: '#8b949e', opacity: .7 }}>from {t.earliest_date}</div>
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <input
                                type="text" maxLength={10}
                                placeholder="직접 입력 (예: FNGU)"
                                value={customTicker}
                                onChange={e => setCustomTicker(e.target.value.toUpperCase())}
                                style={{ flex: 1, fontFamily: 'monospace', fontWeight: 700, textTransform: 'uppercase', border: `2px solid ${customTicker ? '#00d4aa' : '#30363d'}` }}
                            />
                        </div>
                    </div>

                    {/* 기본 설정 */}
                    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 16 }}>
                        <div style={{ fontSize: '.76rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#8b949e', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #30363d' }}>⚙️ 기본 설정</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                            <div><label>시작일</label><input value={form.start_date} onChange={e => setField('start_date', e.target.value)} placeholder="YYYY-MM-DD" /></div>
                            <div><label>종료일</label><input value={form.end_date} onChange={e => setField('end_date', e.target.value)} placeholder="YYYY-MM-DD" /></div>
                            <div><label>초기 투자금 ($)</label><input type="number" value={form.initial_capital} onChange={e => setField('initial_capital', +e.target.value)} min={100} step={1000} /></div>
                            <div><label>월 적립금 ($)</label><input type="number" value={form.monthly_contribution} onChange={e => setField('monthly_contribution', +e.target.value)} min={0} step={100} /></div>
                        </div>
                        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '10px 0' }} />
                        {/* 가짜돌파 방지 */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                            <span style={{ fontSize: '.82rem' }}>가짜돌파 방지 (1일 대기)</span>
                            <label style={{ position: 'relative', width: 40, height: 22, display: 'inline-block', margin: 0 }}>
                                <input type="checkbox" checked={form.confirm_cross} onChange={e => setField('confirm_cross', e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                                <span style={{ position: 'absolute', inset: 0, background: form.confirm_cross ? '#00d4aa' : '#21262d', border: `1px solid ${form.confirm_cross ? '#00d4aa' : '#30363d'}`, borderRadius: 22, cursor: 'pointer', transition: 'background .2s' }}>
                                    <span style={{ position: 'absolute', width: 14, height: 14, left: form.confirm_cross ? 21 : 3, top: 3, background: form.confirm_cross ? '#fff' : '#8b949e', borderRadius: '50%', transition: 'left .2s' }} />
                                </span>
                            </label>
                        </div>
                        <div style={{ marginBottom: 10 }}>
                            <label>스탑로스 임계값 (%)</label>
                            <input type="number" value={form.stoploss_pct} onChange={e => setField('stoploss_pct', +e.target.value)} min={1} max={20} step={0.5} />
                        </div>
                        <div style={{ background: 'rgba(88,166,255,.07)', border: '1px solid rgba(88,166,255,.2)', borderRadius: 6, padding: '8px 12px', fontSize: '.74rem', color: '#8b949e', lineHeight: 1.5 }}>
                            <b style={{ color: '#58a6ff' }}>가짜돌파 방지</b>: 200일선 첫 진입 시 1일 확인 후 매수<br />
                            <b style={{ color: '#58a6ff' }}>부정입학</b>: 갭상승으로 과열 진입 시 첫날도 매수
                        </div>
                    </div>

                    {/* 익절 설정 */}
                    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 16 }}>
                        <div style={{ fontSize: '.76rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#8b949e', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #30363d' }}>💰 배수 익절 설정</div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                            <span style={{ fontSize: '.82rem' }}>익절 전략 사용</span>
                            <label style={{ position: 'relative', width: 40, height: 22, display: 'inline-block', margin: 0 }}>
                                <input type="checkbox" checked={form.profit_taking} onChange={e => setField('profit_taking', e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                                <span style={{ position: 'absolute', inset: 0, background: form.profit_taking ? '#00d4aa' : '#21262d', border: `1px solid ${form.profit_taking ? '#00d4aa' : '#30363d'}`, borderRadius: 22, cursor: 'pointer', transition: 'background .2s' }}>
                                    <span style={{ position: 'absolute', width: 14, height: 14, left: form.profit_taking ? 21 : 3, top: 3, background: form.profit_taking ? '#fff' : '#8b949e', borderRadius: '50%', transition: 'left .2s' }} />
                                </span>
                            </label>
                        </div>
                        {form.profit_taking && (
                            <>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                                    <div><label>익절 기준 (%)</label><input type="number" value={form.profit_start} onChange={e => setField('profit_start', +e.target.value)} min={10} step={10} /></div>
                                    <div><label>익절 간격 (%)</label><input type="number" value={form.profit_spacing} onChange={e => setField('profit_spacing', +e.target.value)} min={10} step={10} /></div>
                                </div>
                                <div><label>익절 시 매도 (%)</label><input type="number" value={form.profit_ratio} onChange={e => setField('profit_ratio', +e.target.value)} min={10} max={100} step={5} /></div>
                            </>
                        )}
                    </div>

                    {/* 딥 바잉 */}
                    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: dipOpen && form.dip_buy_enabled ? 12 : 0 }}>
                            <div style={{ fontSize: '.76rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: '#8b949e' }}>🎯 딥 바잉 (깊은 하락 매수)</div>
                            <label style={{ position: 'relative', width: 40, height: 22, display: 'inline-block', margin: 0 }}>
                                <input type="checkbox" checked={form.dip_buy_enabled} onChange={e => { setField('dip_buy_enabled', e.target.checked); setDipOpen(e.target.checked); }} style={{ opacity: 0, width: 0, height: 0 }} />
                                <span style={{ position: 'absolute', inset: 0, background: form.dip_buy_enabled ? '#00d4aa' : '#21262d', border: `1px solid ${form.dip_buy_enabled ? '#00d4aa' : '#30363d'}`, borderRadius: 22, cursor: 'pointer', transition: 'background .2s' }}>
                                    <span style={{ position: 'absolute', width: 14, height: 14, left: form.dip_buy_enabled ? 21 : 3, top: 3, background: form.dip_buy_enabled ? '#fff' : '#8b949e', borderRadius: '50%', transition: 'left .2s' }} />
                                </span>
                            </label>
                        </div>
                        {form.dip_buy_enabled && (
                            <>
                                <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '10px 0' }} />
                                <div style={{ marginBottom: 10 }}>
                                    <label>하락 임계값 (%, 쉼표 구분)</label>
                                    <input value={form.dip_buy_thresholds} onChange={e => setField('dip_buy_thresholds', e.target.value)} placeholder="-50,-60,-70" />
                                </div>
                                <div>
                                    <label>배분 비중 (%, 쉼표 구분, 합계 100)</label>
                                    <input value={form.dip_buy_allocations} onChange={e => setField('dip_buy_allocations', e.target.value)} placeholder="33,33,34" />
                                </div>
                            </>
                        )}
                    </div>

                    {/* 실행 버튼 */}
                    <button
                        onClick={runBacktest}
                        disabled={loading}
                        style={{ width: '100%', padding: 13, background: 'linear-gradient(135deg,#00d4aa,#00a882)', color: '#000', border: 'none', borderRadius: 8, fontSize: '0.95rem', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? .45 : 1, transition: 'opacity .2s,transform .1s' }}
                    >
                        {loading ? '⏳ 실행 중...' : '🚀 백테스트 실행'}
                    </button>

                </aside>

                {/* ══ 메인 콘텐츠 ════════════════════════════════════════════ */}
                <main style={{ minWidth: 0 }}>
                    {/* 성과 지표 */}
                    {result && (
                        <>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10, marginBottom: 14 }}>
                                {[
                                    { label: '최종 자산', value: `$${fmt(result.result.final_value, 0)}`, cls: 'cyan' },
                                    { label: '총 수익률', value: `${fmt(result.result.total_return, 1)}%`, cls: result.result.total_return >= 0 ? 'green' : 'red' },
                                    { label: 'CAGR', value: `${fmt(result.result.cagr, 1)}%`, cls: 'yellow' },
                                    { label: 'MDD', value: `${fmt(result.result.mdd, 1)}%`, cls: 'red' },
                                    { label: '거래 횟수', value: result.result.trades_count, cls: 'blue' },
                                ].map(m => (
                                    <div key={m.label} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '14px 12px', textAlign: 'center' }}>
                                        <div style={{ fontSize: '.72rem', color: '#8b949e', marginBottom: 6 }}>{m.label}</div>
                                        <div style={{
                                            fontSize: '1.25rem', fontWeight: 700, fontFamily: 'monospace',
                                            color: m.cls === 'green' ? '#4dff88' : m.cls === 'red' ? '#ff6b6b' : m.cls === 'yellow' ? '#ffd700' : m.cls === 'blue' ? '#58a6ff' : '#00d4aa'
                                        }}>{m.value}</div>
                                    </div>
                                ))}
                            </div>

                            {/* 벤치마크 */}
                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                                {Object.entries(result.benchmarks || {}).map(([t, bm]) => (
                                    <div key={t} style={{ background: '#21262d', border: '1px solid #30363d', borderRadius: 20, padding: '5px 14px', fontSize: '.78rem', fontFamily: 'monospace' }}>
                                        <span style={{ color: '#8b949e' }}>{t}</span>
                                        <span style={{ color: '#58a6ff', fontWeight: 600, marginLeft: 6 }}>${fmt(bm.final_value, 0)}</span>
                                        <span style={{ color: bm.total_return >= 0 ? '#4dff88' : '#ff6b6b', marginLeft: 6 }}>({fmt(bm.total_return, 1)}%)</span>
                                    </div>
                                ))}
                                <div style={{ fontSize: '.76rem', color: '#8b949e', alignSelf: 'center' }}>{result.data_period} · {result.trading_days}일</div>
                            </div>
                        </>
                    )}

                    {/* 포트폴리오 차트 */}
                    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 14, marginBottom: 12, height: 280 }}>
                        {!result
                            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8b949e', fontSize: '.9rem' }}>⬅ 백테스트를 실행하면 결과가 여기에 표시됩니다</div>
                            : <canvas ref={portfolioChartRef} style={{ width: '100%', height: '100%' }} />
                        }
                    </div>

                    {/* 가격 + 이벤트 차트 */}
                    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 14, marginBottom: 12, height: 240 }}>
                        {!result
                            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8b949e', fontSize: '.9rem' }}>ETF 가격 및 거래 이벤트</div>
                            : <canvas ref={priceChartRef} style={{ width: '100%', height: '100%' }} />
                        }
                    </div>

                    {/* 거래 내역 */}
                    {result && (
                        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: 14 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                <span style={{ fontSize: '.8rem', fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '.06em' }}>거래 내역</span>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <input
                                        value={filter}
                                        onChange={e => setFilter(e.target.value)}
                                        placeholder="검색..."
                                        style={{ width: 160, padding: '5px 10px', fontSize: '.77rem' }}
                                    />
                                    <button
                                        onClick={() => {
                                            const csv = ['날짜,행동,구간,자산,수익,수익률,포트폴리오'].concat(
                                                trades.map(t => `${t.date},"${t.action}",${t.condition},${t.total_value},${t.gain},${t.gain_pct}%,"${t.portfolio_status}"`)
                                            ).join('\n');
                                            const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
                                            const a = document.createElement('a'); a.href = url; a.download = 'ara_trades.csv'; a.click();
                                            URL.revokeObjectURL(url);
                                        }}
                                        style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #30363d', background: '#21262d', color: '#e6edf3', fontSize: '.77rem', cursor: 'pointer' }}
                                    >
                                        CSV
                                    </button>
                                </div>
                            </div>
                            <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.79rem' }}>
                                    <thead>
                                        <tr>
                                            {['날짜', '행동', '구간', '자산', '수익', '수익률', '포트폴리오 현황'].map(h => (
                                                <th key={h} style={{ position: 'sticky', top: 0, background: '#21262d', padding: '8px 10px', textAlign: 'left', color: '#8b949e', fontWeight: 600, fontSize: '.71rem', textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid #30363d', whiteSpace: 'nowrap' }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredTrades.map((t, i) => (
                                            <tr key={i} style={{ borderBottom: '1px solid rgba(48,54,61,.5)' }}>
                                                <td style={{ padding: '7px 10px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{t.date}</td>
                                                <td style={{ padding: '7px 10px', maxWidth: 300, fontSize: '.74rem' }}>{t.action}</td>
                                                <td style={{ padding: '7px 10px' }}>{conditionTag(t.condition)}</td>
                                                <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>${fmt(t.total_value, 0)}</td>
                                                <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: t.gain >= 0 ? '#4dff88' : '#ff6b6b' }}>${fmt(t.gain, 0)}</td>
                                                <td style={{ padding: '7px 10px', fontFamily: 'monospace', color: t.gain_pct >= 0 ? '#4dff88' : '#ff6b6b' }}>{fmt(t.gain_pct, 1)}%</td>
                                                <td style={{ padding: '7px 10px', fontSize: '.72rem', color: '#8b949e' }}>{t.portfolio_status}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </main>
            </div>
        </>
    );
}
