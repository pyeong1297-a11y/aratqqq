/**
 * 백테스트 엔진 — ARA Backtester
 * backtester.py -> JS 포팅 (딥바잉 전략 제거, 전량익절 옵션 추가)
 */

import { MarketCondition, determineMarketCondition, checkStoploss } from './strategy.js';

const FEE_RATE = 0.0025; // 0.25% 수수료

// --- Portfolio ------------------------------------------------------------------
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

// --- Backtester ----------------------------------------------------------------
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
        profitFullExit = false,  // true 시: 2번째 마일스톤(default 200%)에서 남은 물량 전량 매도
        stoplostPct = 0.05,
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
        this.profitFullExit = profitFullExit;
        this.profitFullExitAt = profitStart + profitSpacing; // 기본: 100+100 = 200%
        this.stoplostPct = stoplostPct;
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

            // 시장 상황
            const condition = determineMarketCondition(leverPrice, ma200);

            const openP = row.leverOpen || leverPrice;
            const highP = row.leverHigh || Math.max(leverPrice, openP);

            // 가짜돌파 방지 및 부정입학 판단
            let sneakEntry = false;
            let justConfirmed = false;

            if (this.confirmCross) {
                if (prevCondition === MarketCondition.DECLINE && (condition === MarketCondition.INVEST || condition === MarketCondition.OVERHEAT)) {
                    // 하락장에서 투자/과열장으로 진입
                    if (condition === MarketCondition.OVERHEAT) {
                        // 종가가 과열로 마무리되면 무조건 부정입학
                        waitingForConfirm = false;
                        sneakEntry = true;
                    } else if (condition === MarketCondition.INVEST && highP > ma200 * 1.05) {
                        // 종가는 집중투자 구간이지만 장중 고가가 과열(ma200 * 1.05)을 터치한 경우 가짜신호로 보지 않고 즉시 진입
                        waitingForConfirm = false;
                        justConfirmed = true;
                    } else {
                        // 일반적인 장중 돌파 -> 가짜돌파 1일 대기
                        waitingForConfirm = true;
                    }
                } else if (waitingForConfirm) {
                    if (condition === MarketCondition.INVEST || condition === MarketCondition.OVERHEAT) {
                        // 대기 후 확인됨 -> 진입
                        waitingForConfirm = false;
                        justConfirmed = true;
                    } else {
                        waitingForConfirm = false;
                    }
                } else if (prevCondition === MarketCondition.INVEST && condition === MarketCondition.OVERHEAT) {
                    if (openP > ma200 * 1.05) {
                        sneakEntry = true;
                    }
                } else if (condition !== MarketCondition.INVEST && condition !== MarketCondition.OVERHEAT) {
                    waitingForConfirm = false;
                }
            } else {
                waitingForConfirm = false;
                sneakEntry = (
                    (prevCondition === MarketCondition.DECLINE || prevCondition === MarketCondition.INVEST)
                    && condition === MarketCondition.OVERHEAT
                );
            }

            // 스탑로스 체크
            let stoplossTriggered = false;
            let stoplossExecPrice = leverPrice;
            if (p.leverShares > 0 && p.leverAvgPrice > 0) {
                const lowP = row.leverLow || leverPrice;
                const slRef = gapEntrySlRef > 0 ? gapEntrySlRef : p.leverAvgPrice;
                const sl = checkStoploss(openP, lowP, leverPrice, slRef, this.stoplostPct);
                stoplossTriggered = sl.triggered;
                stoplossExecPrice = sl.execPrice;
            }

            let tradeAction = null;

            // A) 스탑로스
            if (stoplossTriggered) {
                let gainInfo = '';
                if (p.leverAvgPrice > 0) {
                    const r = (stoplossExecPrice - p.leverAvgPrice) / p.leverAvgPrice * 100;
                    gainInfo = ` [평단$${p.leverAvgPrice.toFixed(2)}->$${stoplossExecPrice.toFixed(2)}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}%]`;
                }
                const spymInfo = this._spymInfo(p, spymPrice);
                p.sellLever(stoplossExecPrice);
                p.sellSpym(spymPrice);
                const buyAmount = p.cash;
                p.buySgov(sgovPrice, p.cash);
                sgovBuyCost = p.sgovShares * sgovPrice;
                sgovBuyDate = date;
                gapEntrySlRef = 0;
                waitingForConfirm = false;
                tradeAction = `🛑 스탑로스(-${(this.stoplostPct * 100).toFixed(0)}%): 전량매도 -> SGOV $${buyAmount.toFixed(0)}${gainInfo}${spymInfo}`;
            }

            // B) 하락 (DECLINE)
            else if (condition === MarketCondition.DECLINE) {
                if (p.leverShares > 0 || p.spymShares > 0) {
                    const gainInfo = this._leverInfo(p, lt, leverPrice);
                    const spymInfo = this._spymInfo(p, spymPrice);
                    p.sellLever(leverPrice);
                    p.sellSpym(spymPrice);
                    p.buySgov(sgovPrice, p.cash);
                    sgovBuyCost = p.sgovShares * sgovPrice;
                    sgovBuyDate = date;
                    gapEntrySlRef = 0;
                    tradeAction = `📉 하락신호: 전량매도 -> SGOV $${(p.sgovShares * sgovPrice).toFixed(0)}${gainInfo}${spymInfo}`;
                } else if (p.cash > 0) {
                    p.buySgov(sgovPrice, p.cash);
                    if (i === 0) {
                        sgovBuyCost = p.sgovShares * sgovPrice;
                        sgovBuyDate = date;
                        tradeAction = `초기투자: SGOV $${(p.sgovShares * sgovPrice).toFixed(0)}`;
                    } else if (monthlyToday) {
                        sgovBuyCost += this.monthlyContribution;
                        tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} -> SGOV`;
                    }
                }
            }

            // C) 집중투자 (INVEST)
            else if (condition === MarketCondition.INVEST) {
                const profitResult = this._checkProfitTaking(p, leverPrice, spymPrice);
                if (profitResult) tradeAction = profitResult;

                if (p.sgovShares > 0) {
                    const sgovInfo = this._sgovInterestInfo(p, sgovPrice, sgovBuyCost, sgovBuyDate, date);
                    if (waitingForConfirm) {
                        tradeAction = tradeAction || `⏳ 200일선 가짜돌파 확인중 (1일 대기)`;
                    } else if (justConfirmed) {
                        p.sellSgov(sgovPrice);
                        p.buyLever(leverPrice, p.cash);
                        sgovBuyCost = 0; sgovBuyDate = null;
                        tradeAction = `📈 집중투자(돌파확인): SGOV -> ${lt} $${(p.leverShares * leverPrice).toFixed(0)} (체결가$${leverPrice.toFixed(2)})${sgovInfo}`;
                    } else {
                        p.sellSgov(sgovPrice);
                        p.buyLever(leverPrice, p.cash);
                        sgovBuyCost = 0; sgovBuyDate = null;
                        tradeAction = `📈 집중투자: SGOV -> ${lt} $${(p.leverShares * leverPrice).toFixed(0)} (체결가$${leverPrice.toFixed(2)})${sgovInfo}`;
                    }
                } else if (p.cash > 0 && !waitingForConfirm) {
                    p.buyLever(leverPrice, p.cash);
                    if (monthlyToday) {
                        tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} -> ${lt} (체결가$${leverPrice.toFixed(2)})`;
                    }
                }
            }

            // D) 과열 (OVERHEAT)
            else if (condition === MarketCondition.OVERHEAT) {
                const profitResult = this._checkProfitTaking(p, leverPrice, spymPrice);
                if (profitResult) tradeAction = profitResult;

                if (p.sgovShares > 0) {
                    const sgovInfo = this._sgovInterestInfo(p, sgovPrice, sgovBuyCost, sgovBuyDate, date);
                    if (waitingForConfirm) {
                        tradeAction = tradeAction || `⏳ 200일선 가짜돌파 확인중 (1일 대기)`;
                    } else if (justConfirmed) {
                        p.sellSgov(sgovPrice);
                        p.buyLever(leverPrice, p.cash);
                        sgovBuyCost = 0; sgovBuyDate = null;
                        const msg = `📈 과열구간 돌파매수: SGOV -> ${lt} $${(p.leverShares * leverPrice).toFixed(0)} (체결가$${leverPrice.toFixed(2)})${sgovInfo}`;
                        tradeAction = tradeAction ? `${tradeAction} + ${msg}` : msg;
                    } else if (sneakEntry) {
                        p.sellSgov(sgovPrice);
                        p.buyLever(leverPrice, p.cash);
                        sgovBuyCost = 0; sgovBuyDate = null;
                        gapEntrySlRef = ma200 * 1.01;
                        const msg = `🚀 부정입학(갭상승): SGOV -> ${lt} $${(p.leverShares * leverPrice).toFixed(0)} (체결가$${leverPrice.toFixed(2)})${sgovInfo}`;
                        tradeAction = tradeAction ? `${tradeAction} + ${msg}` : msg;
                    } else if (p.cash > 0) {
                        p.buySpym(spymPrice, p.cash);
                        if (monthlyToday) tradeAction = `[월적립] $${this.monthlyContribution.toFixed(0)} -> SPYM(과열)`;
                    }
                } else if (p.cash > 0) {
                    p.buySpym(spymPrice, p.cash);
                    if (monthlyToday) {
                        tradeAction = tradeAction ? `${tradeAction} + [월적립] SPYM` : `[월적립] $${this.monthlyContribution.toFixed(0)} -> SPYM(과열)`;
                    } else if (i === 0) {
                        tradeAction = `초기투자(과열): SPYM $${(p.spymShares * spymPrice).toFixed(0)}`;
                    }
                }
            }

            // 포트폴리오 가치 기록
            const tv = p.totalValue(leverPrice, spymPrice, sgovPrice);
            portfolioValues.push({ date, dateStr, totalValue: tv, leverValue: p.leverShares * leverPrice, spymValue: p.spymShares * spymPrice, sgovValue: p.sgovShares * sgovPrice, cash: p.cash, condition, leverPrice, ma200 });

            if (tradeAction) {
                const gain = tv - totalContributed;
                const gainPct = totalContributed > 0 ? gain / totalContributed * 100 : 0;
                trades.push({ date, dateStr, action: tradeAction, condition, totalValue: tv, totalContributed, gain, gainPct, portfolioStatus: p.statusStr(lt, leverPrice, spymPrice) });
            }

            prevCondition = condition;
        }

        if (portfolioValues.length === 0) return null;
        const lastPV = portfolioValues[portfolioValues.length - 1];
        if (!trades.length || trades[trades.length - 1].dateStr !== lastPV.dateStr) {
            const gain = lastPV.totalValue - totalContributed;
            trades.push({ date: lastPV.date, dateStr: lastPV.dateStr, action: '백테스트 종료 (최종)', condition: lastPV.condition, totalValue: lastPV.totalValue, totalContributed, gain, gainPct: totalContributed > 0 ? gain / totalContributed * 100 : 0, portfolioStatus: '' });
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
    _checkProfitTaking(p, leverPrice, spymPrice) {
        if (!this.profitTaking || p.leverShares <= 0 || p.leverAvgPrice <= 0) return null;
        const profitRate = (leverPrice - p.leverAvgPrice) / p.leverAvgPrice * 100;
        if (profitRate < this.profitStart) return null;

        const milestone = Math.floor((profitRate - this.profitStart) / this.profitSpacing) * this.profitSpacing + this.profitStart;
        if (milestone < this.profitStart || milestone <= p.lastMilestone) return null;

        // 전량익절 조건: profitFullExit ON이고 2번째 이상 마일스톤(default 200%)
        const isFullExit = this.profitFullExit && milestone >= this.profitFullExitAt;
        const ratio = isFullExit ? 1.0 : this.profitRatio;

        const sellShares = p.leverShares * ratio;
        const sellValue = sellShares * leverPrice;
        p.sellLever(leverPrice, ratio);
        p.buySpym(spymPrice, p.cash > 0 ? Math.min(p.cash, sellValue * (1 - FEE_RATE)) : sellValue * (1 - FEE_RATE));
        p.lastMilestone = milestone;

        if (isFullExit) {
            return `🎯 전량익절+${milestone.toFixed(0)}%: ${this.leverTicker} ${sellShares.toFixed(2)}주 전량매도($${sellValue.toFixed(0)}) -> SPYM`;
        }
        return `💰 익절+${milestone.toFixed(0)}%: ${this.leverTicker} ${sellShares.toFixed(2)}주 매도($${sellValue.toFixed(0)}) -> SPYM`;
    }

    _leverInfo(p, ticker, price) {
        if (p.leverShares > 0.0001 && p.leverAvgPrice > 0) {
            const r = (price - p.leverAvgPrice) / p.leverAvgPrice * 100;
            return ` [${ticker} 평단$${p.leverAvgPrice.toFixed(2)}->${r >= 0 ? '+' : ''}${r.toFixed(1)}%]`;
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
