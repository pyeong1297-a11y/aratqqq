'use client';

import { useState, useEffect, useRef } from 'react';
import {
    Chart, CategoryScale, LinearScale,
    PointElement, LineElement, Title, Tooltip, Legend,
    Filler, ScatterController, LineController
} from 'chart.js';

Chart.register(
    CategoryScale, LinearScale,
    PointElement, LineElement, Title, Tooltip, Legend,
    Filler, ScatterController, LineController
);

const TICKERS_STATIC = [
    { ticker: 'TQQQ', description: '나스닥 100 3배', earliest_date: '2010-02-11' },
    { ticker: 'BITU', description: '비트코인 2배', earliest_date: '2022-06-22' },
    { ticker: 'SOLT', description: '솔라나 2배', earliest_date: '2024-02-22' },
    { ticker: 'ETHU', description: '이더리움 2배', earliest_date: '2022-10-04' },
    { ticker: 'BULZ', description: '혁신기업15 3배', earliest_date: '2021-08-18' },
];

const fmt = (v, d = 2) =>
    v == null ? '-' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// ─── Toggle Switch Component ────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
    return (
        <label style={{ position: 'relative', width: 40, height: 22, display: 'inline-block', flexShrink: 0 }}>
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
                style={{ opacity: 0, width: 0, height: 0 }} />
            <span style={{
                position: 'absolute', inset: 0,
                background: checked ? '#00d4aa' : '#21262d',
                border: `1px solid ${checked ? '#00d4aa' : '#30363d'}`,
                borderRadius: 22, cursor: 'pointer', transition: 'background .2s'
            }}>
                <span style={{
                    position: 'absolute', width: 14, height: 14,
                    left: checked ? 21 : 3, top: 3,
                    background: checked ? '#fff' : '#8b949e',
                    borderRadius: '50%', transition: 'left .2s'
                }} />
            </span>
        </label>
    );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
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
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    const [trades, setTrades] = useState([]);
    const [filter, setFilter] = useState('');
    const [sidebarOpen, setSidebarOpen] = useState(false);

    const portfolioChartRef = useRef(null);
    const priceChartRef = useRef(null);
    const portfolioChart = useRef(null);
    const priceChart = useRef(null);

    const activeTicker = customTicker || selectedTicker;

    function setField(key, val) {
        setForm(f => ({ ...f, [key]: val }));
    }

    useEffect(() => {
        if (result && !loading) renderCharts(result);
    }, [result, loading]);

    async function runBacktest() {
        setLoading(true);
        setError('');
        setSidebarOpen(false);  // 모바일에서 실행 후 자동으로 사이드바 닫기
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

        if (portfolioChart.current) portfolioChart.current.destroy();

        const bmStyles = {
            QQQ: { color: '#6e7681', bw: 1.2 },
            QLD: { color: '#c9a227', bw: 1.2 },
            TQQQ: { color: '#e67e22', bw: 1.4 },
        };
        const bmDatasets = Object.entries(chart_data.benchmarks || {}).map(([ticker, values]) => ({
            label: ticker, data: values,
            borderColor: bmStyles[ticker]?.color || '#f39c12',
            borderWidth: bmStyles[ticker]?.bw || 1.2,
            pointRadius: 0, tension: 0.2,
        }));

        portfolioChart.current = new Chart(portfolioChartRef.current, {
            type: 'line',
            data: {
                labels,
                datasets: [...bmDatasets, {
                    label: 'ARA 전략', data: chart_data.strategyValues,
                    borderColor: '#00d4aa', borderWidth: 2.5,
                    pointRadius: 0, tension: 0.2, fill: false,
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: {
                    legend: { labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 14 } },
                    tooltip: {
                        mode: 'index', intersect: false,
                        callbacks: { label: ctx => `${ctx.dataset.label}: $${fmt(ctx.parsed.y, 0)}` },
                    },
                },
                scales: {
                    x: { ticks: { color: '#8b949e', maxTicksLimit: 6 }, grid: { color: '#30363d22' } },
                    y: {
                        ticks: { color: '#8b949e', callback: v => v >= 1000 ? `$${(v / 1000).toFixed(0)}K` : `$${v}` },
                        grid: { color: '#30363d22' },
                    },
                },
            },
        });

        if (priceChart.current) priceChart.current.destroy();

        const eventsDataset = {
            type: 'scatter', label: '이벤트',
            data: (tradesList || []).filter(t => t.chart_label).map(t => {
                const idx = labels.indexOf(t.date);
                return idx >= 0 ? { x: t.date, y: chart_data.leverPrices[idx], label: t.chart_label } : null;
            }).filter(Boolean),
            pointRadius: 7, pointStyle: 'circle',
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
                    { label: `${data.lever_ticker} 가격`, data: chart_data.leverPrices, borderColor: '#58a6ff', borderWidth: 1.4, pointRadius: 0, tension: 0.1 },
                    { label: 'MA200', data: chart_data.ma200.map(v => v > 0 ? v : null), borderColor: '#ff9500', borderWidth: 1.8, borderDash: [4, 3], pointRadius: 0, tension: 0.1 },
                    eventsDataset,
                ],
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: {
                    legend: { labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 14 } },
                    tooltip: {
                        callbacks: {
                            label: ctx => ctx.dataset.type === 'scatter' && ctx.raw?.label
                                ? `${ctx.raw.label}: $${fmt(ctx.raw.y, 2)}`
                                : `${ctx.dataset.label}: $${fmt(ctx.parsed.y, 2)}`
                        },
                    },
                },
                scales: {
                    x: { ticks: { color: '#8b949e', maxTicksLimit: 6 }, grid: { color: '#30363d22' } },
                    y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d22' } },
                },
            },
        });
    }

    const filteredTrades = trades.filter(t =>
        !filter || t.action?.toLowerCase().includes(filter.toLowerCase()) || t.date?.includes(filter)
    );

    const condTag = c => {
        const cfg = c === '하락' ? ['rgba(255,107,107,.15)', '#ff6b6b'] : c === '집중투자' ? ['rgba(77,255,136,.12)', '#4dff88'] : ['rgba(255,215,0,.12)', '#ffd700'];
        return <span style={{ background: cfg[0], color: cfg[1], padding: '1px 8px', borderRadius: 10, fontSize: '.7rem', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</span>;
    };

    // ── compact metric card ────
    const MetricCard = ({ label, value, color }) => (
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: '.68rem', color: '#8b949e', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, fontFamily: 'monospace', color }}>{value}</div>
        </div>
    );

    // ── inline label + field group ────
    const Field = ({ label, children }) => (
        <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: '.75rem', color: '#8b949e', marginBottom: 3, display: 'block' }}>{label}</label>
            {children}
        </div>
    );

    const inputStyle = {
        background: '#21262d', border: '1px solid #30363d', borderRadius: 6,
        color: '#e6edf3', fontSize: '.875rem', padding: '7px 10px',
        outline: 'none', width: '100%',
    };

    return (
        <>
            <style>{`
                *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
                html, body { background: #0d1117; color: #e6edf3; font-family: 'Inter','Malgun Gothic',sans-serif; overflow-x: hidden; }
                @keyframes spin { to { transform: rotate(360deg); } }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
                input:focus, select:focus { border-color: #00d4aa !important; outline: none; }

                /* Layout */
                .layout {
                    display: grid;
                    grid-template-columns: 300px 1fr;
                    gap: 12px;
                    padding: 12px 16px 40px;
                    max-width: 1700px;
                    margin: 0 auto;
                }

                /* Mobile overlay sidebar */
                .sidebar-overlay {
                    display: none;
                    position: fixed; inset: 0;
                    background: rgba(0,0,0,.6);
                    z-index: 100;
                }
                .sidebar-overlay.open { display: block; }
                .sidebar {
                    display: flex; flex-direction: column; gap: 10px;
                }

                /* Metrics grid */
                .metrics-grid {
                    display: grid;
                    grid-template-columns: repeat(5, 1fr);
                    gap: 8px;
                    margin-bottom: 12px;
                }

                /* Benchmark row */
                .bm-row {
                    display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center;
                }

                /* Charts */
                .chart-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
                .chart-portfolio { height: 260px; }
                .chart-price { height: 220px; }

                /* Card */
                .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; }
                .card-title { font-size: .74rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #30363d; }

                /* Mobile menu button */
                .mobile-menu-btn {
                    display: none;
                    background: #161b22; border: 1px solid #30363d;
                    color: #e6edf3; padding: 8px 14px;
                    border-radius: 8px; cursor: pointer; font-size: .85rem;
                }

                /* 반응형 */
                @media (max-width: 900px) {
                    .layout {
                        grid-template-columns: 1fr;
                        padding: 10px 12px 40px;
                    }
                    .sidebar {
                        position: fixed; top: 0; right: 0; bottom: 0;
                        width: min(320px, 90vw);
                        background: #0d1117;
                        overflow-y: auto;
                        padding: 16px;
                        z-index: 101;
                        transform: translateX(100%);
                        transition: transform .25s ease;
                        display: flex; flex-direction: column; gap: 10px;
                    }
                    .sidebar.open { transform: translateX(0); }
                    .metrics-grid { grid-template-columns: repeat(3, 1fr); }
                    .mobile-menu-btn { display: inline-flex; align-items: center; gap: 6px; }
                    .chart-portfolio { height: 220px; }
                    .chart-price { height: 180px; }
                }
                @media (max-width: 500px) {
                    .metrics-grid { grid-template-columns: repeat(2, 1fr); }
                    .chart-portfolio { height: 190px; }
                    .chart-price { height: 160px; }
                }
            `}</style>

            {/* Loading */}
            {loading && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(13,17,23,.85)', zIndex: 999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                    <div style={{ width: 44, height: 44, border: '4px solid #30363d', borderTopColor: '#00d4aa', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
                    <div style={{ color: '#00d4aa', fontSize: '.9rem' }}>백테스트 실행 중…</div>
                </div>
            )}
            {error && (
                <div style={{ position: 'fixed', bottom: 20, right: 16, background: '#2d1b1b', border: '1px solid #ff6b6b', color: '#ff6b6b', padding: '10px 16px', borderRadius: 8, zIndex: 1000, maxWidth: 'calc(100vw - 32px)', animation: 'fadeIn .25s' }}>
                    ⚠️ {error}
                    <button onClick={() => setError('')} style={{ marginLeft: 10, background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer' }}>✕</button>
                </div>
            )}

            {/* Mobile overlay */}
            <div className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

            {/* Header */}
            <header style={{ background: 'linear-gradient(135deg,#161b22,#0d1117)', borderBottom: '1px solid #30363d', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: '1.6rem' }}>📈</span>
                    <div>
                        <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#00d4aa', lineHeight: 1.2 }}>ARA Backtester</h1>
                        <p style={{ fontSize: '.72rem', color: '#8b949e', marginTop: 1 }}>레버리지 ETF 200일선 투자법</p>
                    </div>
                </div>
                <button className="mobile-menu-btn" onClick={() => setSidebarOpen(o => !o)}>
                    ⚙️ 설정
                </button>
            </header>

            <div className="layout">
                {/* ══ Sidebar (settings) ════════════════════════════════════════ */}
                <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>

                    {/* 모바일 닫기 */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>⚙️ 설정</div>
                        <button onClick={() => setSidebarOpen(false)}
                            style={{ background: 'none', border: 'none', color: '#8b949e', fontSize: '1.2rem', cursor: 'pointer', padding: 4 }}>✕</button>
                    </div>

                    {/* 티커 선택 */}
                    <div className="card">
                        <div className="card-title">📌 레버리지 ETF 선택</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                            {TICKERS_STATIC.map(t => (
                                <div key={t.ticker}
                                    onClick={() => { setSelectedTicker(t.ticker); setCustomTicker(''); }}
                                    style={{
                                        background: (activeTicker === t.ticker && !customTicker) ? 'rgba(0,212,170,.08)' : '#21262d',
                                        border: `2px solid ${(activeTicker === t.ticker && !customTicker) ? '#00d4aa' : '#30363d'}`,
                                        borderRadius: 8, padding: '8px 6px', cursor: 'pointer', textAlign: 'center', transition: 'all .15s',
                                    }}>
                                    <div style={{ fontSize: '.95rem', fontWeight: 700, color: '#00d4aa', fontFamily: 'monospace' }}>{t.ticker}</div>
                                    <div style={{ fontSize: '.63rem', color: '#8b949e', marginTop: 2 }}>{t.description}</div>
                                    <div style={{ fontSize: '.6rem', color: '#8b949e', opacity: .7 }}>from {t.earliest_date}</div>
                                </div>
                            ))}
                        </div>
                        <input
                            type="text" maxLength={10}
                            placeholder="직접 입력 (예: FNGU)"
                            value={customTicker}
                            onChange={e => setCustomTicker(e.target.value.toUpperCase())}
                            style={{ ...inputStyle, fontFamily: 'monospace', fontWeight: 700, border: `2px solid ${customTicker ? '#00d4aa' : '#30363d'}` }}
                        />
                    </div>

                    {/* 기본 설정 */}
                    <div className="card">
                        <div className="card-title">⚙️ 기본 설정</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                            <Field label="시작일"><input value={form.start_date} onChange={e => setField('start_date', e.target.value)} placeholder="YYYY-MM-DD" style={inputStyle} /></Field>
                            <Field label="종료일"><input value={form.end_date} onChange={e => setField('end_date', e.target.value)} placeholder="YYYY-MM-DD" style={inputStyle} /></Field>
                            <Field label="초기 투자금 ($)"><input type="number" value={form.initial_capital} onChange={e => setField('initial_capital', +e.target.value)} min={100} step={1000} style={inputStyle} /></Field>
                            <Field label="월 적립금 ($)"><input type="number" value={form.monthly_contribution} onChange={e => setField('monthly_contribution', +e.target.value)} min={0} step={100} style={inputStyle} /></Field>
                        </div>
                        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '8px 0' }} />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontSize: '.8rem' }}>가짜돌파 방지 (1일 대기)</span>
                            <Toggle checked={form.confirm_cross} onChange={v => setField('confirm_cross', v)} />
                        </div>
                        <Field label="스탑로스 임계값 (%)">
                            <input type="number" value={form.stoploss_pct} onChange={e => setField('stoploss_pct', +e.target.value)} min={1} max={20} step={0.5} style={inputStyle} />
                        </Field>
                        <div style={{ background: 'rgba(88,166,255,.07)', border: '1px solid rgba(88,166,255,.2)', borderRadius: 6, padding: '7px 10px', fontSize: '.72rem', color: '#8b949e', lineHeight: 1.5 }}>
                            <b style={{ color: '#58a6ff' }}>가짜돌파 방지</b>: 200일선 첫 진입 시 1일 확인 후 매수<br />
                            <b style={{ color: '#58a6ff' }}>부정입학</b>: 갭상승으로 과열 진입 시 첫날도 매수
                        </div>
                    </div>

                    {/* 익절 설정 */}
                    <div className="card">
                        <div className="card-title">💰 배수 익절 설정</div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: form.profit_taking ? 10 : 0 }}>
                            <span style={{ fontSize: '.8rem' }}>익절 전략 사용</span>
                            <Toggle checked={form.profit_taking} onChange={v => setField('profit_taking', v)} />
                        </div>
                        {form.profit_taking && (
                            <>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                                    <Field label="익절 기준 (%)"><input type="number" value={form.profit_start} onChange={e => setField('profit_start', +e.target.value)} min={10} step={10} style={inputStyle} /></Field>
                                    <Field label="익절 간격 (%)"><input type="number" value={form.profit_spacing} onChange={e => setField('profit_spacing', +e.target.value)} min={10} step={10} style={inputStyle} /></Field>
                                </div>
                                <Field label="익절 시 매도 (%)">
                                    <input type="number" value={form.profit_ratio} onChange={e => setField('profit_ratio', +e.target.value)} min={10} max={100} step={5} style={inputStyle} />
                                </Field>
                            </>
                        )}
                    </div>

                    {/* 실행 버튼 */}
                    <button
                        onClick={runBacktest} disabled={loading}
                        style={{ width: '100%', padding: '13px', background: 'linear-gradient(135deg,#00d4aa,#00a882)', color: '#000', border: 'none', borderRadius: 8, fontSize: '.95rem', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? .45 : 1, transition: 'opacity .2s' }}>
                        {loading ? '⏳ 실행 중...' : '🚀 백테스트 실행'}
                    </button>
                </aside>

                {/* ══ Main Content ══════════════════════════════════════════════ */}
                <main style={{ minWidth: 0 }}>

                    {/* 모바일 실행 버튼 (데스크탑에서 숨김) */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10, justifyContent: 'flex-end' }}>
                        <button onClick={() => setSidebarOpen(true)}
                            className="mobile-menu-btn">⚙️ 설정 열기</button>
                    </div>

                    {/* 성과 지표 */}
                    {result && (
                        <>
                            <div className="metrics-grid">
                                <MetricCard label="최종 자산" value={`$${fmt(result.result.final_value, 0)}`} color="#00d4aa" />
                                <MetricCard label="총 수익률" value={`${fmt(result.result.total_return, 1)}%`} color={result.result.total_return >= 0 ? '#4dff88' : '#ff6b6b'} />
                                <MetricCard label="CAGR" value={`${fmt(result.result.cagr, 1)}%`} color="#ffd700" />
                                <MetricCard label="MDD" value={`${fmt(result.result.mdd, 1)}%`} color="#ff6b6b" />
                                <MetricCard label="거래 횟수" value={result.result.trades_count} color="#58a6ff" />
                            </div>

                            <div className="bm-row">
                                {Object.entries(result.benchmarks || {}).map(([t, bm]) => (
                                    <div key={t} style={{ background: '#21262d', border: '1px solid #30363d', borderRadius: 20, padding: '4px 12px', fontSize: '.75rem', fontFamily: 'monospace' }}>
                                        <span style={{ color: '#8b949e' }}>{t}</span>
                                        <span style={{ color: '#58a6ff', fontWeight: 600, marginLeft: 5 }}>${fmt(bm.final_value, 0)}</span>
                                        <span style={{ color: bm.total_return >= 0 ? '#4dff88' : '#ff6b6b', marginLeft: 4 }}>({fmt(bm.total_return, 1)}%)</span>
                                    </div>
                                ))}
                                <span style={{ fontSize: '.72rem', color: '#8b949e' }}>{result.data_period}</span>
                            </div>
                        </>
                    )}

                    {/* 포트폴리오 차트 */}
                    <div className="chart-box chart-portfolio">
                        {!result
                            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8b949e', fontSize: '.85rem', textAlign: 'center' }}>⬅ 설정 후 백테스트를 실행하면 결과가 표시됩니다</div>
                            : <canvas ref={portfolioChartRef} style={{ width: '100%', height: '100%' }} />
                        }
                    </div>

                    {/* 가격 차트 */}
                    <div className="chart-box chart-price">
                        {!result
                            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8b949e', fontSize: '.85rem' }}>ETF 가격 및 거래 이벤트</div>
                            : <canvas ref={priceChartRef} style={{ width: '100%', height: '100%' }} />
                        }
                    </div>

                    {/* 거래 내역 */}
                    {result && (
                        <div className="card">
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                                <span style={{ fontSize: '.78rem', fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '.06em' }}>거래 내역</span>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="검색..." style={{ ...inputStyle, width: 140, padding: '5px 8px', fontSize: '.75rem' }} />
                                    <button
                                        onClick={() => {
                                            const csv = ['날짜,행동,구간,자산,수익,수익률'].concat(
                                                trades.map(t => `${t.date},"${t.action}",${t.condition},${t.total_value},${t.gain},${t.gain_pct}%`)
                                            ).join('\n');
                                            const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
                                            const a = document.createElement('a'); a.href = url; a.download = 'ara_trades.csv'; a.click();
                                            URL.revokeObjectURL(url);
                                        }}
                                        style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #30363d', background: '#21262d', color: '#e6edf3', fontSize: '.75rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                        CSV
                                    </button>
                                </div>
                            </div>
                            <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.77rem', minWidth: 560 }}>
                                    <thead>
                                        <tr>
                                            {['날짜', '행동', '구간', '자산', '수익', '수익률'].map(h => (
                                                <th key={h} style={{ position: 'sticky', top: 0, background: '#21262d', padding: '7px 8px', textAlign: 'left', color: '#8b949e', fontWeight: 600, fontSize: '.68rem', textTransform: 'uppercase', borderBottom: '1px solid #30363d', whiteSpace: 'nowrap' }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredTrades.map((t, i) => (
                                            <tr key={i} style={{ borderBottom: '1px solid rgba(48,54,61,.4)' }}>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace', whiteSpace: 'nowrap', fontSize: '.72rem' }}>{t.date}</td>
                                                <td style={{ padding: '6px 8px', maxWidth: 240, fontSize: '.72rem' }}>{t.action}</td>
                                                <td style={{ padding: '6px 8px' }}>{condTag(t.condition)}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>${fmt(t.total_value, 0)}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: t.gain >= 0 ? '#4dff88' : '#ff6b6b' }}>${fmt(t.gain, 0)}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: t.gain_pct >= 0 ? '#4dff88' : '#ff6b6b' }}>{fmt(t.gain_pct, 1)}%</td>
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
