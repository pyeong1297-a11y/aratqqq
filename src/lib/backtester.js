/**
 * 백테스트 엔진 — ARA Backtester
 * backtester.py → JS 포팅
 */

import { MarketCondition, determineMarketCondition, checkStoploss } from './strategy.js';

const FEE_RATE = 0.0025; // 0.25% 수수료

// ─── Portfolio ──────────────────────────────────────────────────────────────
class Portfolio {
    constructor(initialCash = 10000) {
        this.cash = initialCash;
        this.leverShares = 0;
        this.leverAvgPrice = 0;
        this.lastMilestone = 0;
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
        const sh = this._buyShares(price, amount);
        if (sh <= 0) return;
        const totalCost = this.spymShares * this.spymAvgPrice + amount;
        this.spymShares += sh;
        this.spymAvgPrice = totalCost / this.spymShares;
        this.cash -= amount;
    }

    buySgov(price, amount) {
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
            this.leverShares = 0; this.leverAvgPrice = 0; this.lastMilestone = 0;
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

    sellSgovAmount(price, amount) {
        if (amount <= 0 || price <= 0 || this.sgovShares <= 0) return 0;
        const sharesToSell = Math.min(this.sgovShares, amount / price);
        const proceeds = this._sellProceeds(sharesToSell, price);
        this.sgovShares -= sharesToSell;
        if (this.sgovShares <= 0.0001) { this.sgovShares = 0; this.sgovAvgPrice = 0; }
        this.cash += proceeds;
        return proceeds;
    }

    totalValue(leverPrice, spymPrice, sgovPrice) {
        return this.cash
            + this.leverShares * leverPrice
            + this.spymShares * spymPrice
            + this.sgovShares * sgovPrice;
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

// ─── Backtester ─────────────────────────────────────────────────────────────
export class Backtester {
    constructor({
        data,
        leverTicker = 'TQQQ',
        initialCapital = 10000,
        monthlyContribution = 0,
        profitTaking = true,
        profitStart = 100,
        profitRatio = 0.5,
        profitSpacing = 100,
        stoplostPct = 0.05,
        dipBuyEnabled = false,
        dipBuyThresholds = [-50, -60, -70],
        dipBuyAllocations = [0.33, 0.33, 0.34],
        confirmCross = true,
        sellSpymOnInvest = false,
    }) {
        this.data = data;
        this.leverTicker = leverTicker;
        this.initialCapital = initialCapital;
        this.monthlyContribution = monthlyContribution;
        this.profitTaking = profitTaking;
        this.profitStart = profitStart;
        this.profitRatio = profitRatio;
        this.profitSpacing = profitSpacing > 0 ? profitSpacing : 100;
        this.stoplostPct = stoplostPct;
        this.dipBuyEnabled = dipBuyEnabled;
        this.dipBuyThresholds = [...dipBuyThresholds].sort((a, b) => a - b);
        this.dipBuyAllocations = dipBuyAllocations;
        this.confirmCross = confirmCross;
        this.sellSpymOnInvest = sellSpymOnInvest;
    }

    run() {
        const p = new Portfolio(this.initialCapital);
        const lt = this.leverTicker;
        let prevCondition = null;
        let waitingForConfirm = false;
        let lastContribMonth = null;
        let totalContributed = this.initialCapital;
        let sgovBuyCost = 0;
        let sgovBuyDate = null;
        let gapEntrySlRef = 0;

        const triggeredDips = {};
        if (this.dipBuyEnabled) {
            for (const t of this.dipBuyThresholds) triggeredDips[t] = false;
        }
        let dipBuyBaseSgov = 0;
        let dipHoldShares = 0;
        let dipHoldCost = 0;

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

            // ── 월별 적립 ────────────────────────────────────────────────────────
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

            // ── 시장 상황 ─────────────────────────────────────────────────────────
            const condition = determineMarketCondition(leverPrice, ma200);

            // ── 가짜돌파 방지 ─────────────────────────────────────────────────────
            if (this.confirmCross) {
                if (prevCondition === MarketCondition.DECLINE && condition === MarketCondition.INVEST) {
                    waitingForConfirm = true;
                } else if (condition === MarketCondition.INVEST && prevCondition === MarketCondition.INVEST) {
                    waitingForConfirm = false;
                } else if (condition !== MarketCondition.INVEST) {
                    waitingForConfirm = false;
                }
            } else {
                waitingForConfirm = false;
            }

            // 부정입학 감지
            const sneakEntry = (
                (prevCondition === MarketCondition.DECLINE || prevCondition === MarketCondition.INVEST)
                && condition === MarketCondition.OVERHEAT
            );

            // ── 스탑로스 체크 ─────────────────────────────────────────────────────
            let stoplossTriggered = false;
            let stoplossExecPrice = leverPrice;
            if (p.leverShares > 0 && p.leverAvgPrice > 0) {
                const openP = row.leverOpen || leverPrice;
                const lowP = row.leverLow || leverPrice;
                const slRef = gapEntrySlRef > 0 ? gapEntrySlRef : p.leverAvgPrice;
                const sl = checkStoploss(openP, lowP, leverPrice, slRef, this.stoplostPct);
                stoplossTriggered = sl.triggered;
                stoplossExecPrice = sl.execPrice;
            }

            let tradeAction = null;

            // ─────────────────────────────────────────────────────────────────────
            // A) 스탑로스
            // ─────────────────────────────────────────────────────────────────────
            if (stoplossTriggered) {
                let gainInfo = '';
                if (p.leverAvgPrice > 0) {
                    const r = (stoplossExecPrice - p.leverAvgPrice) / p.leverAvgPrice * 100;
                    gainInfo = ` [평단$${p.leverAvgPrice.toFixed(2)}→$${stoplossExecPrice.toFixed(2)}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}%]`;
                }
                const spymInfo = this._spymInfo(p, spymPrice);
                p.sellLever(stoplossExecPrice);
                p.sellSpym(spymPrice);
                const buyAmount = p.cash;
                p.buySgov(sgovPrice, p.cash);
                sgovBuyCost = p.sgovShares * sgovPrice;
                sgovBuyDate = date;
                dipBuyBaseSgov = sgovBuyCost;
                gapEntrySlRef = 0;
                waitingForConfirm = false;
                tradeAction = `🛑 스탑로스(-${(this.stoplostPct * 100).toFixed(0)}%): 전량매도 → SGOV $${buyAmount.toFixed(0)}${gainInfo}${spymInfo}`;
            }

            // ─────────────────────────────────────────────────────────────────────
            // B) 하락 (DECLINE)
            // ─────────────────────────────────────────────────────────────────────
            else if (condition === MarketCondition.DECLINE) {
                if (p.leverShares > 0 || p.spymShares > 0) {
                    const gainInfo = this._leverInfo(p, lt, leverPrice);
                    const spymInfo = this._spymInfo(p, spymPrice);
                    const procL = p.sellLever(leverPrice);
                    const procS = p.sellSpym(spymPrice);
                    const totalP = procL + procS;
                    p.buySgov(sgovPrice, p.cash);
                    sgovBuyCost = p.sgovShares * sgovPrice;
                    sgovBuyDate = date;
                    dipBuyBaseSgov = sgovBuyCost;
                    gapEntrySlRef = 0;
                    const dipMsg = dipHoldShares > 0 ? ` | 딥바잉 ${dipHoldShares.toFixed(1)}주 장기보유중` : '';
                    tradeAction = `📉 하락신호: 전량매도 → SGOV $${totalP.toFixed(0)}${gainInfo}${spymInfo}${dipMsg}`;
                } else if (p.cash > 0) {
                    p.buySgov(sgovPrice, p.cash);
                    if (i === 0) {
                        sgovBuyCost = p.sgovShares * sgovPrice;
                        sgovBuyDate = date;
                        dipBuyBaseSgov = sgovBuyCost;
                        tradeAction = `초기투자: SGOV $${(p.sgovShares * sgovPrice).toFixed(0)}`;
                    } else if (monthlyToday) {
                        sgovBuyCost += this.monthlyContribution;
                        tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} → SGOV`;
                    }
                }

                // 딥 바잉 체크
                if (this.dipBuyEnabled && p.sgovShares > 0) {
                    const dd = row.leverDD || 0;
                    if (dipBuyBaseSgov <= 0) dipBuyBaseSgov = p.sgovShares * sgovPrice;
                    for (let idx = 0; idx < this.dipBuyThresholds.length; idx++) {
                        const thr = this.dipBuyThresholds[idx];
                        const alloc = this.dipBuyAllocations[idx] ?? this.dipBuyAllocations[this.dipBuyAllocations.length - 1];
                        if (dd <= thr && !triggeredDips[thr]) {
                            const sgovVal = p.sgovShares * sgovPrice;
                            const buyAmt = Math.min(dipBuyBaseSgov * alloc, sgovVal);
                            if (buyAmt > 10) {
                                const sharesBefore = p.sgovShares;
                                p.sellSgovAmount(sgovPrice, buyAmt);
                                if (sharesBefore > 0) sgovBuyCost *= (p.sgovShares / sharesBefore);
                                const newSh = p.cash * (1 - FEE_RATE) / leverPrice;
                                dipHoldShares += newSh;
                                dipHoldCost += p.cash;
                                p.cash = 0;
                                triggeredDips[thr] = true;
                                const dipMsg2 = `딥바잉(${thr}%, ${(alloc * 100).toFixed(0)}%): SGOV $${buyAmt.toFixed(0)} → ${lt} ${newSh.toFixed(1)}주 장기보유`;
                                tradeAction = tradeAction ? `${tradeAction} + ${dipMsg2}` : dipMsg2;
                            }
                        }
                    }
                }
            }

            // ─────────────────────────────────────────────────────────────────────
            // C) 집중투자 (INVEST)
            // ─────────────────────────────────────────────────────────────────────
            else if (condition === MarketCondition.INVEST) {
                if (this.dipBuyEnabled && (row.leverDD || 0) > -20) {
                    for (const t of this.dipBuyThresholds) triggeredDips[t] = false;
                    dipBuyBaseSgov = 0;
                }

                if (dipHoldShares > 0) {
                    const dipAvg = dipHoldCost / dipHoldShares;
                    const dipPct = (leverPrice / dipAvg - 1) * 100;
                    if (p.leverShares > 0) {
                        const tot = p.leverAvgPrice * p.leverShares + dipHoldCost;
                        const totSh = p.leverShares + dipHoldShares;
                        p.leverAvgPrice = tot / totSh;
                        p.leverShares = totSh;
                    } else {
                        p.leverShares = dipHoldShares;
                        p.leverAvgPrice = dipAvg;
                    }
                    const merge = ` [딥바잉 ${dipHoldShares.toFixed(1)}주 합류 | 평단$${dipAvg.toFixed(2)}, ${dipPct >= 0 ? '+' : ''}${dipPct.toFixed(1)}%]`;
                    dipHoldShares = 0; dipHoldCost = 0; p.lastMilestone = 0;
                    tradeAction = `딥바잉 200일선 복귀 → 일반전략 합류${merge}`;
                }

                // 배수 익절
                const profitResult = this._checkProfitTaking(p, leverPrice, spymPrice);
                if (profitResult) {
                    tradeAction = tradeAction ? `${tradeAction} + ${profitResult}` : profitResult;
                }

                // SGOV → 레버리지 ETF 전환
                if (p.sgovShares > 0) {
                    const sgovInfo = this._sgovInterestInfo(p, sgovPrice, sgovBuyCost, sgovBuyDate, date);
                    if (waitingForConfirm) {
                        tradeAction = tradeAction || `⏳ 200일선 가짜돌파 확인중 (1일 대기)`;
                    } else {
                        p.sellSgov(sgovPrice);
                        let spymReinvestInfo = '';
                        if (this.sellSpymOnInvest && p.spymShares > 0) {
                            const spymVal = p.spymShares * spymPrice;
                            p.sellSpym(spymPrice);
                            spymReinvestInfo = ` [SPYM $${spymVal.toFixed(0)} 재투자]`;
                        }
                        p.buyLever(leverPrice, p.cash);
                        sgovBuyCost = 0; sgovBuyDate = null;
                        tradeAction = `📈 집중투자: SGOV → ${lt} $${(p.leverShares * leverPrice).toFixed(0)} (체결가$${leverPrice.toFixed(2)})${sgovInfo}${spymReinvestInfo}`;
                    }
                } else if (p.leverShares > 0 && !waitingForConfirm) {
                    if (this.sellSpymOnInvest && p.spymShares > 0) {
                        const spymVal = p.spymShares * spymPrice;
                        p.sellSpym(spymPrice);
                        p.buyLever(leverPrice, p.cash);
                        const msg = `SPYM $${spymVal.toFixed(0)} → ${lt} 재투자 (체결가$${leverPrice.toFixed(2)})`;
                        tradeAction = tradeAction ? `${tradeAction} + ${msg}` : msg;
                    } else if (p.cash > 0) {
                        p.buyLever(leverPrice, p.cash);
                        if (monthlyToday) {
                            tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} → ${lt} (체결가$${leverPrice.toFixed(2)} | 현재평단$${p.leverAvgPrice.toFixed(2)})`;
                        }
                    }
                }
            }

            // ─────────────────────────────────────────────────────────────────────
            // D) 과열 (OVERHEAT)
            // ─────────────────────────────────────────────────────────────────────
            else if (condition === MarketCondition.OVERHEAT) {
                const profitResult = this._checkProfitTaking(p, leverPrice, spymPrice);
                if (profitResult) tradeAction = profitResult;

                if (p.sgovShares > 0) {
                    const sgovInfo = this._sgovInterestInfo(p, sgovPrice, sgovBuyCost, sgovBuyDate, date);
                    if (sneakEntry) {
                        p.sellSgov(sgovPrice);
                        p.buyLever(leverPrice, p.cash);
                        sgovBuyCost = 0; sgovBuyDate = null;
                        gapEntrySlRef = ma200 * 1.01;
                        const msg = `🚀 부정입학(갭상승): SGOV → ${lt} $${(p.leverShares * leverPrice).toFixed(0)} (체결가$${leverPrice.toFixed(2)})${sgovInfo}`;
                        tradeAction = tradeAction ? `${tradeAction} + ${msg}` : msg;
                    } else if (p.cash > 0) {
                        p.buySpym(spymPrice, p.cash);
                        if (monthlyToday) {
                            tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} → SPYM(과열구간, 체결가$${spymPrice.toFixed(2)})`;
                        }
                    }
                } else if (p.cash > 0) {
                    p.buySpym(spymPrice, p.cash);
                    if (monthlyToday) {
                        tradeAction = tradeAction
                            ? `${tradeAction} + [월적립] SPYM`
                            : `[월적립] $${this.monthlyContribution.toFixed(0)} → SPYM(과열구간)`;
                    } else if (i === 0) {
                        tradeAction = `초기투자(과열): SPYM $${(p.spymShares * spymPrice).toFixed(0)}`;
                    }
                }
            }

            // ── 포트폴리오 가치 기록 ───────────────────────────────────────────────
            const dipValue = dipHoldShares * leverPrice;
            const tv = p.totalValue(leverPrice, spymPrice, sgovPrice) + dipValue;

            portfolioValues.push({
                date, dateStr,
                totalValue: tv,
                leverValue: p.leverShares * leverPrice + dipValue,
                spymValue: p.spymShares * spymPrice,
                sgovValue: p.sgovShares * sgovPrice,
                cash: p.cash,
                condition,
                leverPrice,
                ma200,
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
                    portfolioStatus: p.statusStr(lt, leverPrice, spymPrice),
                });
            }

            prevCondition = condition;
        }

        // 최종 현황 강제 기록
        if (portfolioValues.length === 0) return null;
        const lastPV = portfolioValues[portfolioValues.length - 1];
        if (!trades.length || trades[trades.length - 1].dateStr !== lastPV.dateStr) {
            const gain = lastPV.totalValue - totalContributed;
            const gainPct = totalContributed > 0 ? gain / totalContributed * 100 : 0;
            trades.push({
                date: lastPV.date, dateStr: lastPV.dateStr,
                action: '백테스트 종료 (최종)',
                condition: lastPV.condition,
                totalValue: lastPV.totalValue,
                totalContributed,
                gain, gainPct,
                portfolioStatus: '',
            });
        }

        // 성과 지표
        const values = portfolioValues.map(v => v.totalValue);
        const finalValue = values[values.length - 1];
        const startDate = portfolioValues[0].date;
        const endDate = portfolioValues[portfolioValues.length - 1].date;
        const years = (endDate - startDate) / (365.25 * 24 * 3600 * 1000);
        const cagr = years > 0 ? ((finalValue / totalContributed) ** (1 / years) - 1) * 100 : 0;

        let runMax = values[0], mdd = 0;
        for (const v of values) {
            if (v > runMax) runMax = v;
            const dd = (v - runMax) / runMax * 100;
            if (dd < mdd) mdd = dd;
        }
        const totalReturn = (finalValue - totalContributed) / totalContributed * 100;

        return { finalValue, totalContributed, totalReturn, cagr, mdd, portfolioValues, trades };
    }

    // ─── 헬퍼 ─────────────────────────────────────────────────────────────────
    _checkProfitTaking(p, leverPrice, spymPrice) {
        if (!this.profitTaking || p.leverShares <= 0 || p.leverAvgPrice <= 0) return null;
        const profitRate = (leverPrice - p.leverAvgPrice) / p.leverAvgPrice * 100;
        if (profitRate < this.profitStart) return null;
        const milestone = Math.floor((profitRate - this.profitStart) / this.profitSpacing) * this.profitSpacing + this.profitStart;
        if (milestone < this.profitStart || milestone <= p.lastMilestone) return null;
        const sellShares = p.leverShares * this.profitRatio;
        const sellValue = sellShares * leverPrice;
        const proceeds = p.sellLever(leverPrice, this.profitRatio);
        p.buySpym(spymPrice, proceeds);
        p.lastMilestone = milestone;
        return `💰 익절+${milestone.toFixed(0)}%: ${this.leverTicker} ${sellShares.toFixed(2)}주 매도($${sellValue.toFixed(0)}) → SPYM`;
    }

    _leverInfo(p, ticker, price) {
        if (p.leverShares > 0.0001 && p.leverAvgPrice > 0) {
            const r = (price - p.leverAvgPrice) / p.leverAvgPrice * 100;
            return ` [${ticker} 평단$${p.leverAvgPrice.toFixed(2)}→$${price.toFixed(2)}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}%]`;
        }
        return '';
    }

    _spymInfo(p, price) {
        if (p.spymShares > 0.0001 && p.spymAvgPrice > 0) {
            const r = (price - p.spymAvgPrice) / p.spymAvgPrice * 100;
            return ` [SPYM 평단$${p.spymAvgPrice.toFixed(2)}→$${price.toFixed(2)}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}%]`;
        }
        return '';
    }

    _sgovInterestInfo(p, sgovPrice, buyCost, buyDate, currentDate) {
        if (buyCost > 0 && p.sgovShares > 0 && buyDate) {
            const val = p.sgovShares * sgovPrice;
            const interest = val - buyCost;
            const days = Math.round((currentDate - buyDate) / (24 * 3600 * 1000));
            return ` [SGOV ${days}일 보유, 이자$${interest >= 0 ? '+' : ''}${interest.toFixed(2)}]`;
        }
        return '';
    }
}

// ─── 벤치마크 ────────────────────────────────────────────────────────────────
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
