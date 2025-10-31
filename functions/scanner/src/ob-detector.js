// OB 检测逻辑（从 shared/utils.js 复制）
function findPotentialOrderBlocks(klines, swingLength, volumeLookback, volumeMethod, volumeParam) {
  let bullishOBs = [];
  let bearishOBs = [];
  let lastSwingHigh = null;
  let lastSwingLow = null;

  function getVolumeThreshold(startIndex, endIndex, method, param) {
    const vols = klines.slice(startIndex, endIndex).map(k => k.volume).filter(v => v > 0);
    if (vols.length === 0) return 0;

    if (method === 'percentile') {
      const sorted = [...vols].sort((a, b) => a - b);
      const idx = Math.floor((param / 100) * (sorted.length - 1));
      return sorted[idx];
    }
    return 0;
  }

  for (let i = swingLength; i < klines.length; i++) {
    const refIndex = i - swingLength;
    const windowSlice = klines.slice(refIndex + 1, i + 1);
    if (windowSlice.length === 0) continue;

    const maxHighInWindow = Math.max(...windowSlice.map(c => c.high));
    if (klines[refIndex].high > maxHighInWindow) {
      lastSwingHigh = { ...klines[refIndex], index: refIndex, crossed: false };
    }

    const minLowInWindow = Math.min(...windowSlice.map(c => c.low));
    if (klines[refIndex].low < minLowInWindow) {
      lastSwingLow = { ...klines[refIndex], index: refIndex, crossed: false };
    }

    const currentCandle = klines[i];

    // 看涨 OB
    if (lastSwingHigh && !lastSwingHigh.crossed && currentCandle.close > lastSwingHigh.high) {
      const volThreshold = getVolumeThreshold(Math.max(0, i - volumeLookback), i, volumeMethod, volumeParam);
      if (currentCandle.volume >= volThreshold) {
        lastSwingHigh.crossed = true;
        const searchRange = klines.slice(lastSwingHigh.index, i);
        if (searchRange.length > 0) {
          const bestCandle = searchRange.reduce((prev, curr) => prev.low < curr.low ? prev : curr);
          bullishOBs.push({
            ...bestCandle,
            type: 'BULLISH',
            creationIndex: i,
            confirmationCandle: {
              index: i,
              timestamp: currentCandle.timestamp,
              close: currentCandle.close,
              volume: currentCandle.volume
            },
            confidence: bestCandle.volume >= volThreshold ? "high" : "low",
            isValid: true,
            isBroken: false
          });
        }
      }
    }

    // 看跌 OB
    if (lastSwingLow && !lastSwingLow.crossed && currentCandle.close < lastSwingLow.low) {
      const volThreshold = getVolumeThreshold(Math.max(0, i - volumeLookback), i, volumeMethod, volumeParam);
      if (currentCandle.volume >= volThreshold) {
        lastSwingLow.crossed = true;
        const searchRange = klines.slice(lastSwingLow.index, i);
        if (searchRange.length > 0) {
          const bestCandle = searchRange.reduce((prev, curr) => prev.high > curr.high ? prev : curr);
          bearishOBs.push({
            ...bestCandle,
            type: 'BEARISH',
            creationIndex: i,
            confirmationCandle: {
              index: i,
              timestamp: currentCandle.timestamp,
              close: currentCandle.close,
              volume: currentCandle.volume
            },
            confidence: bestCandle.volume >= volThreshold ? "high" : "low",
            isValid: true,
            isBroken: false
          });
        }
      }
    }
  }

  return { bullishOBs, bearishOBs };
}

module.exports = { findPotentialOrderBlocks };