/**
 * 투자 전략 로직 - 시장 상황 판단 (2구간)
 * aratqqq2 전략 기반 — MA200 위/아래의 단순 2구간
 */

export const MarketCondition = {
    SAFE: 'SAFE',       // MA200 아래 → 안전자산(SGOV) 대기
    INVEST: 'INVEST',   // MA200 위 → TQQQ 투자
};

/**
 * 레버리지 ETF 종가와 200일선을 비교하여 구간 반환 (2구간)
 */
export function determineMarketCondition(price, ma200) {
    if (ma200 <= 0 || price < ma200) return MarketCondition.SAFE;
    return MarketCondition.INVEST;
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
