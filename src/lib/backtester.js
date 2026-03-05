/**
 * 백테스트 엔진 — ARA Backtester (2구간 전략 기반)
 * aratqqq2 로직 이식 — MA200 위/아래 2구간, 절반스탑로스, +100/200/300% 익절
 */

import { MarketCondition, determineMarketCondition, checkStoploss } from './strategy.js';

const FEE_RATE = 0.0025; // 0.25% 수수료

// --- Portfolio ------------------------------------------------------------------
class Portfolio {
    constructor(initialCash = 10000) {
        this.cash = initialCash;
        this.leverShares = 0;
        this.leverAvgPrice = 0;
        this.spymShares = 0;
        this.spymAvgPrice = 0;
        this.sgovShares = 0;
        this.sgovAvgPrice = 0;
    }

    _buyShares(price, amount) {
        if (amount <= 0 || price <= 0) return 0;
        return (amount * (1 - FEE_RATE)) / price;
    }

    buyLever(price, amount) {
        const sh = this._buyShares(price, amount);
        if (sh <= 0) return;
        const totalCost = this.leverShares * this.leverAvgPrice + amount;
        this.leverShares += sh;
        this.leverAvgPrice = totalCost / this.leverShares;
        this.cash -= amount;
    }

    buySpym(price, amount) {
        if (amount <= 0 || price <= 0) return;
        const sh = this._buyShares(price, amount);
        if (sh <= 0) return;
        const totalCost = this.spymShares * this.spymAvgPrice + amount;
        this.spymShares += sh;
        this.spymAvgPrice = totalCost / this.spymShares;
        this.cash -= amount;
    }

    buySgov(price, amount) {
        if (amount <= 0 || price <= 0) return;
        const sh = this._buyShares(price, amount);
        if (sh <= 0) return;
        const totalCost = this.sgovShares * this.sgovAvgPrice + amount;
        this.sgovShares += sh;
        this.sgovAvgPrice = totalCost / this.sgovShares;
        this.cash -= amount;
    }

    _sellProceeds(shares, price) {
        return shares * price * (1 - FEE_RATE);
    }

    sellLever(price, ratio = 1.0) {
        if (this.leverShares <= 0) return 0;
        const sellSh = this.leverShares * ratio;
        const proceeds = this._sellProceeds(sellSh, price);
        this.leverShares -= sellSh;
        this.cash += proceeds;
        if (this.leverShares <= 0.0001) {
            this.leverShares = 0; this.leverAvgPrice = 0;
        }
        return proceeds;
    }

    sellSpym(price) {
        if (this.spymShares <= 0) return 0;
        const proceeds = this._sellProceeds(this.spymShares, price);
        this.spymShares = 0; this.spymAvgPrice = 0;
        this.cash += proceeds;
        return proceeds;
    }

    sellSgov(price) {
        if (this.sgovShares <= 0) return 0;
        const proceeds = this._sellProceeds(this.sgovShares, price);
        this.sgovShares = 0; this.sgovAvgPrice = 0;
        this.cash += proceeds;
        return proceeds;
    }

    totalValue(leverPrice, spymPrice, sgovPrice) {
        return this.cash
            + this.leverShares * leverPrice
            + this.spymShares * (spymPrice || 0)
            + this.sgovShares * (sgovPrice || 1);
    }

    statusStr(leverTicker, leverPrice, spymPrice) {
        const parts = [];
        if (this.leverShares > 0.0001 && this.leverAvgPrice > 0) {
            const gain = (leverPrice - this.leverAvgPrice) / this.leverAvgPrice * 100;
            parts.push(`${leverTicker}: 평단$${this.leverAvgPrice.toFixed(2)}(${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%)`);
        }
        if (this.spymShares > 0.0001 && this.spymAvgPrice > 0) {
            const gain = (spymPrice - this.spymAvgPrice) / this.spymAvgPrice * 100;
            parts.push(`SPYM: 평단$${this.spymAvgPrice.toFixed(2)}(${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%)`);
        }
        if (this.sgovShares > 0.0001) parts.push('SGOV 보유중');
        return parts.join(' | ');
    }
}

// --- Backtester ----------------------------------------------------------------
export class Backtester {
    constructor({
        data,
        leverTicker = 'TQQQ',
        initialCapital = 10000,
        monthlyContribution = 0,
        // 익절 설정
        profitTaking = true,
        profitStart = 100,           // 첫 익절 기준 (%)
        profitRatio = 0.5,           // 익절 시 매도 비율 (0.5 = 50%)
        profitSpacing = 100,         // 익절 간격 (%)  → 100,200,300...
        profitToSpym = 0.5,          // 익절금 중 SPYM 비율 (나머지는 SGOV)
        // 스탑로스 설정
        stoplostPct = 0.05,          // 스탑로스 임계값 (-5%)
        // 진입 확인
        consUpRequired = 2,          // MA200 위 연속 일수 (기본 2일)
    }) {
        this.data = data;
        this.leverTicker = leverTicker;
        this.initialCapital = initialCapital;
        this.monthlyContribution = monthlyContribution;
        this.profitTaking = profitTaking;
        this.profitStart = profitStart;
        this.profitRatio = profitRatio;
        this.profitSpacing = profitSpacing > 0 ? profitSpacing : 100;
        this.profitToSpym = profitToSpym;
        this.stoplostPct = stoplostPct;
        this.consUpRequired = consUpRequired >= 1 ? consUpRequired : 2;

        // 익절 마일스톤 배열 생성 (profitStart~800%, profitSpacing 간격)
        this._profitMilestones = [];
        for (let lv = profitStart; lv <= 800; lv += this.profitSpacing) {
            this._profitMilestones.push(lv);
        }
    }

    run() {
        const p = new Portfolio(this.initialCapital);
        const lt = this.leverTicker;

        let state = 'SAFE';    // 'SAFE' | 'INVESTED'
        let entryPrice = 0;
        let consUp = 0;
        let profitTaken = new Set();
        let lastContribMonth = null;
        let totalContributed = this.initialCapital;
        let sgovBuyCost = 0;
        let sgovBuyDate = null;

        // 절반 스탑로스 상태
        let halfSLActive = false;

        const portfolioValues = [];
        const trades = [];

        for (let i = 0; i < this.data.length; i++) {
            const row = this.data[i];
            const leverPrice = row[lt] || 0;
            const spymPrice = row['SPYM'] || leverPrice;
            const sgovPrice = row['SGOV'] || 1.0;
            const ma200 = row.ma200 || 0;
            const date = row.date;
            const dateStr = row.dateStr;

            if (leverPrice <= 0) continue;

            // 월별 적립
            const yearMonth = `${date.getFullYear()}-${date.getMonth()}`;
            let monthlyToday = false;
            if (i === 0) {
                lastContribMonth = yearMonth;
            } else if (this.monthlyContribution > 0) {
                if (lastContribMonth !== yearMonth && date.getDate() >= 21) {
                    p.cash += this.monthlyContribution;
                    totalContributed += this.monthlyContribution;
                    lastContribMonth = yearMonth;
                    monthlyToday = true;
                }
            }

            // 2구간 시장 판단
            const condition = determineMarketCondition(leverPrice, ma200);

            // 스탑로스 체크 (INVESTED 중, halfSLActive가 아닐 때)
            let stoplossTriggered = false;
            let stoplossExecPrice = leverPrice;
            if (state === 'INVESTED' && !halfSLActive && p.leverShares > 0 && p.leverAvgPrice > 0) {
                const lowP = row.leverLow || leverPrice;
                const sl = checkStoploss(
                    row.leverOpen || leverPrice,
                    lowP,
                    leverPrice,
                    p.leverAvgPrice,
                    this.stoplostPct
                );
                stoplossTriggered = sl.triggered;
                stoplossExecPrice = sl.execPrice;
            }

            let tradeAction = null;

            // ══ A) 스탑로스 ══
            if (stoplossTriggered) {
                const gainInfo = this._leverInfo(p, lt, stoplossExecPrice);
                // 절반 스탑로스: 50% 매도 → SGOV, 나머지 50% 유지
                p.sellSpym(spymPrice);
                p.sellLever(stoplossExecPrice, 0.5);
                const buyAmt = p.cash;
                p.buySgov(sgovPrice, p.cash);
                sgovBuyCost = p.sgovShares * sgovPrice;
                sgovBuyDate = date;
                halfSLActive = true;
                tradeAction = `⚡ 절반스탑로스(-${(this.stoplostPct * 100).toFixed(0)}%): 50%매도→SGOV $${buyAmt.toFixed(0)}, 나머지50% 대기${gainInfo}`;
            }

            // ══ B) SAFE 구간 (MA200 아래) ══
            else if (condition === MarketCondition.SAFE) {
                if (state === 'INVESTED' || halfSLActive) {
                    // 하락 → 전량 매도 → SGOV
                    const gainInfo = this._leverInfo(p, lt, leverPrice);
                    const spymInfo = this._spymInfo(p, spymPrice);
                    p.sellLever(leverPrice);
                    p.sellSpym(spymPrice);
                    p.sellSgov(sgovPrice);
                    p.buySgov(sgovPrice, p.cash);
                    sgovBuyCost = p.sgovShares * sgovPrice;
                    sgovBuyDate = date;
                    halfSLActive = false;
                    entryPrice = 0;
                    consUp = 0;
                    profitTaken.clear();
                    state = 'SAFE';
                    tradeAction = `📉 하락(MA200 이탈): 전량→SGOV $${(p.sgovShares * sgovPrice).toFixed(0)}${gainInfo}${spymInfo}`;
                } else {
                    // SAFE → 현금을 SGOV로
                    if (p.cash > 0) {
                        p.buySgov(sgovPrice, p.cash);
                        sgovBuyCost += this.monthlyContribution > 0 && monthlyToday ? this.monthlyContribution : (i === 0 ? this.initialCapital : 0);
                        if (i === 0) {
                            sgovBuyCost = p.sgovShares * sgovPrice;
                            sgovBuyDate = date;
                            tradeAction = `초기투자: SGOV $${(p.sgovShares * sgovPrice).toFixed(0)}`;
                        } else if (monthlyToday) {
                            sgovBuyCost += this.monthlyContribution;
                            tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} → SGOV`;
                        }
                    }
                    consUp = 0;
                }
            }

            // ══ C) INVEST 구간 (MA200 위) ══
            else if (condition === MarketCondition.INVEST) {
                if (state === 'SAFE') {
                    // 현금이 있으면 SGOV에 추가
                    if (p.cash > 0) {
                        p.buySgov(sgovPrice, p.cash);
                        if (monthlyToday) {
                            sgovBuyCost += this.monthlyContribution;
                            tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} → SGOV (진입 대기중)`;
                        }
                    }
                    // 연속 상승 카운트
                    consUp++;
                    if (consUp >= this.consUpRequired && p.sgovShares > 0) {
                        // 진입!
                        const sgovInfo = this._sgovInterestInfo(p, sgovPrice, sgovBuyCost, sgovBuyDate, date);
                        p.sellSgov(sgovPrice);
                        p.buyLever(leverPrice, p.cash);
                        entryPrice = p.leverAvgPrice;
                        sgovBuyCost = 0; sgovBuyDate = null;
                        state = 'INVESTED';
                        profitTaken.clear();
                        tradeAction = `🚀 진입(${this.consUpRequired}일 연속 MA위): SGOV → ${lt} $${(p.leverShares * leverPrice).toFixed(0)} (체결가$${leverPrice.toFixed(2)})${sgovInfo}`;
                    }
                } else if (state === 'INVESTED') {
                    // halfSL 해제 처리: MA200 위로 확인 → 재매수
                    if (halfSLActive) {
                        // 절반 스탑로스 후 MA200 위 → 기존 lever 유지하고 SGOV 매도 후 재매수
                        const sgovInfo = this._sgovInterestInfo(p, sgovPrice, sgovBuyCost, sgovBuyDate, date);
                        p.sellSgov(sgovPrice);
                        p.buyLever(leverPrice, p.cash);
                        halfSLActive = false;
                        sgovBuyCost = 0; sgovBuyDate = null;
                        tradeAction = `🔄 절반SL 후 재매수: SGOV→${lt} $${(p.leverShares * leverPrice).toFixed(0)}${sgovInfo}`;
                    }

                    // 익절 체크
                    const profitResult = this._checkProfitTaking(p, leverPrice, spymPrice, sgovPrice);
                    if (profitResult) tradeAction = tradeAction ? `${tradeAction} + ${profitResult}` : profitResult;

                    // 월 적립금 → lever 추가 매수
                    if (monthlyToday && p.cash > 0) {
                        p.buyLever(leverPrice, p.cash);
                        tradeAction = tradeAction || `[월적립] $${this.monthlyContribution.toFixed(0)} → ${lt}`;
                    }
                }
            }

            // 포트폴리오 가치 기록
            const tv = p.totalValue(leverPrice, spymPrice, sgovPrice);
            portfolioValues.push({
                date, dateStr,
                totalValue: tv,
                leverValue: p.leverShares * leverPrice,
                spymValue: p.spymShares * (spymPrice || 0),
                sgovValue: p.sgovShares * sgovPrice,
                cash: p.cash,
                condition,
                leverPrice,
                ma200
            });

            if (tradeAction) {
                const gain = tv - totalContributed;
                const gainPct = totalContributed > 0 ? gain / totalContributed * 100 : 0;
                trades.push({
                    date, dateStr,
                    action: tradeAction,
                    condition,
                    totalValue: tv,
                    totalContributed,
                    gain,
                    gainPct,
                    portfolioStatus: p.statusStr(lt, leverPrice, spymPrice)
                });
            }
        }

        if (portfolioValues.length === 0) return null;

        // 종료 레코드
        const lastPV = portfolioValues[portfolioValues.length - 1];
        if (!trades.length || trades[trades.length - 1].dateStr !== lastPV.dateStr) {
            const gain = lastPV.totalValue - totalContributed;
            trades.push({
                date: lastPV.date, dateStr: lastPV.dateStr,
                action: '백테스트 종료 (최종)',
                condition: lastPV.condition,
                totalValue: lastPV.totalValue,
                totalContributed,
                gain,
                gainPct: totalContributed > 0 ? gain / totalContributed * 100 : 0,
                portfolioStatus: ''
            });
        }

        const values = portfolioValues.map(v => v.totalValue);
        const finalValue = values[values.length - 1];
        const years = (portfolioValues[portfolioValues.length - 1].date - portfolioValues[0].date) / (365.25 * 24 * 3600 * 1000);
        const cagr = years > 0 ? ((finalValue / totalContributed) ** (1 / years) - 1) * 100 : 0;

        let runMax = values[0], mdd = 0;
        for (const v of values) {
            if (v > runMax) runMax = v;
            const dd = (v - runMax) / runMax * 100;
            if (dd < mdd) mdd = dd;
        }

        return {
            finalValue,
            totalContributed,
            totalReturn: (finalValue - totalContributed) / totalContributed * 100,
            cagr,
            mdd,
            portfolioValues,
            trades,
        };
    }

    // --- 헬퍼 -------------------------------------------------------------------
    _checkProfitTaking(p, leverPrice, spymPrice, sgovPrice) {
        if (!this.profitTaking || p.leverShares <= 0 || p.leverAvgPrice <= 0) return null;
        const profitRate = (leverPrice - p.leverAvgPrice) / p.leverAvgPrice * 100;
        if (profitRate < this.profitStart) return null;

        const milestone = Math.floor((profitRate - this.profitStart) / this.profitSpacing) * this.profitSpacing + this.profitStart;
        if (milestone < this.profitStart) return null;

        // 이미 해당 마일스톤 익절했으면 스킵
        if (this._profitMilestones.indexOf(milestone) < 0) return null;
        const milestoneKey = milestone;
        if (p._lastMilestone >= milestoneKey) return null;
        p._lastMilestone = milestoneKey;

        // 절반 매도
        const sellRatio = this.profitRatio;
        const proceeds = p.sellLever(leverPrice, sellRatio);

        // 매도금의 SPYM 비율 + SGOV 비율로 분배
        const toSpym = proceeds * this.profitToSpym;
        const toSgov = proceeds * (1 - this.profitToSpym);

        if (spymPrice > 0) p.buySpym(spymPrice, toSpym);
        p.buySgov(sgovPrice, toSgov);

        return `💰 익절+${milestone.toFixed(0)}%: ${this.leverTicker} ${(sellRatio * 100).toFixed(0)}%매도 → SPYM ${(this.profitToSpym * 100).toFixed(0)}%+SGOV ${((1 - this.profitToSpym) * 100).toFixed(0)}%`;
    }

    _leverInfo(p, ticker, price) {
        if (p.leverShares > 0.0001 && p.leverAvgPrice > 0) {
            const r = (price - p.leverAvgPrice) / p.leverAvgPrice * 100;
            return ` [${ticker} 평단$${p.leverAvgPrice.toFixed(2)}→${r >= 0 ? '+' : ''}${r.toFixed(1)}%]`;
        }
        return '';
    }

    _spymInfo(p, price) {
        if (p.spymShares > 0.0001 && p.spymAvgPrice > 0) {
            const r = (price - p.spymAvgPrice) / p.spymAvgPrice * 100;
            return ` [SPYM 평단$${p.spymAvgPrice.toFixed(2)}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}%]`;
        }
        return '';
    }

    _sgovInterestInfo(p, sgovPrice, buyCost, buyDate, currentDate) {
        if (buyCost > 0 && p.sgovShares > 0 && buyDate) {
            const interest = p.sgovShares * sgovPrice - buyCost;
            const days = Math.round((currentDate - buyDate) / (24 * 3600 * 1000));
            return ` [SGOV ${days}일, 이자$${interest >= 0 ? '+' : ''}${interest.toFixed(2)}]`;
        }
        return '';
    }
}

// --- 벤치마크 ------------------------------------------------------------------
export function calculateBenchmark(data, ticker, initialCapital, monthlyContribution) {
    const rows = data.filter(r => r[ticker] != null && r[ticker] > 0);
    if (rows.length === 0) return [];

    let shares = initialCapital / rows[0][ticker];
    let lastMonth = `${rows[0].date.getFullYear()}-${rows[0].date.getMonth()}`;
    const values = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const price = row[ticker];
        const ym = `${row.date.getFullYear()}-${row.date.getMonth()}`;
        if (i > 0 && monthlyContribution > 0 && lastMonth !== ym && row.date.getDate() >= 21) {
            shares += monthlyContribution / price;
            lastMonth = ym;
        }
        values.push({ date: row.date, dateStr: row.dateStr, value: shares * price });
    }
    return values;
}
