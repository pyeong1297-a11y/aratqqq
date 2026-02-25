/**
 * 투자 전략 로직 - 시장 상황 판단 (3구간)
 * strategy.py → JS 포팅
 */

export const MarketCondition = {
    DECLINE: '하락',
    INVEST: '집중투자',
    OVERHEAT: '과열',
};

/**
 * 레버리지 ETF 종가와 200일선을 비교하여 시장 구간 반환
 */
export function determineMarketCondition(price, ma200) {
    if (ma200 <= 0) return MarketCondition.DECLINE;
    if (price < ma200) return MarketCondition.DECLINE;
    if (price < ma200 * 1.05) return MarketCondition.INVEST;
    return MarketCondition.OVERHEAT;
}

/**
 * 스탑로스 발동 여부 및 실행 가격 반환
 * @returns {{ triggered: boolean, execPrice: number }}
 */
export function checkStoploss(openPrice, lowPrice, closePrice, avgBuyPrice, threshold = 0.05) {
    if (avgBuyPrice <= 0) return { triggered: false, execPrice: closePrice };

    const stopTarget = avgBuyPrice * (1 - threshold);

    if (openPrice <= stopTarget) return { triggered: true, execPrice: openPrice };
    if (lowPrice <= stopTarget) return { triggered: true, execPrice: stopTarget };
    if (closePrice <= stopTarget) return { triggered: true, execPrice: closePrice };

    return { triggered: false, execPrice: closePrice };
}
