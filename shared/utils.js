/**
 * Order Block 检测逻辑（从之前的代码复制）
 */
function findPotentialOrderBlocks(
  klines,
  swingLength,
  volumeLookback = 20,
  volumeMethod = 'percentile',
  volumeParam = 70
) {
  let bullishOBs = [];
  let bearishOBs = [];
  let lastSwingHigh = null;
  let lastSwingLow = null;

  function getVolumeThreshold(startIndex, endIndex, method, param) {
    const vols = klines
      .slice(startIndex, endIndex)
      .map((k) => k.volume)
      .filter((v) => v > 0);

    if (vols.length === 0) return 0;

    switch (method) {
      case 'percentile': {
        const sorted = [...vols].sort((a, b) => a - b);
        const idx = Math.floor((param / 100) * (sorted.length - 1));
        return sorted[idx];
      }
      case 'sma': {
        const sum = vols.reduce((a, b) => a + b, 0);
        const sma = sum / vols.length;
        return sma * param;
      }
      case 'ema': {
        const k = 2 / (vols.length + 1);
        let ema = vols[0];
        for (let i = 1; i < vols.length; i++) {
          ema = vols[i] * k + ema * (1 - k);
        }
        return ema * param;
      }
      case 'stddev': {
        const sum = vols.reduce((a, b) => a + b, 0);
        const mean = sum / vols.length;
        const variance = vols.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / vols.length;
        const stddev = Math.sqrt(variance);
        return mean + (stddev * param);
      }
      default:
        return 0;
    }
  }

  for (let i = swingLength; i < klines.length; i++) {
    const refIndex = i - swingLength;
    const windowSlice = klines.slice(refIndex + 1, i + 1);

    if (windowSlice.length === 0) continue;

    // 寻找波段高点
    const maxHighInWindow = Math.max(...windowSlice.map((c) => c.high));
    if (klines[refIndex].high > maxHighInWindow) {
      lastSwingHigh = { ...klines[refIndex], index: refIndex, crossed: false };
    }

    // 寻找波段低点
    const minLowInWindow = Math.min(...windowSlice.map((c) => c.low));
    if (klines[refIndex].low < minLowInWindow) {
      lastSwingLow = { ...klines[refIndex], index: refIndex, crossed: false };
    }

    const currentCandle = klines[i];

    // 看涨 OB
    if (lastSwingHigh && !lastSwingHigh.crossed && currentCandle.close > lastSwingHigh.high) {
      const volThresholdForBreakout = getVolumeThreshold(
        Math.max(0, i - volumeLookback),
        i,
        volumeMethod,
        volumeParam
      );

      if (currentCandle.volume >= volThresholdForBreakout) {
        lastSwingHigh.crossed = true;
        const searchRange = klines.slice(lastSwingHigh.index, i);

        if (searchRange.length > 0) {
          let bestCandle = null;
          const volThresholdForOB = getVolumeThreshold(
            Math.max(0, lastSwingHigh.index - volumeLookback),
            i,
            volumeMethod,
            volumeParam
          );

          for (const candle of searchRange) {
            if (candle.volume >= volThresholdForOB) {
              if (!bestCandle || candle.low < bestCandle.low) {
                bestCandle = candle;
              }
            }
          }

          if (!bestCandle) {
            bestCandle = searchRange.reduce((prev, curr) =>
              prev.low < curr.low ? prev : curr
            );
          }

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
            confidence: bestCandle.volume >= volThresholdForOB ? "high" : "low",
            isValid: true,
            isBroken: false
          });
        }
      }
    }

    // 看跌 OB
    if (lastSwingLow && !lastSwingLow.crossed && currentCandle.close < lastSwingLow.low) {
      const volThresholdForBreakout = getVolumeThreshold(
        Math.max(0, i - volumeLookback),
        i,
        volumeMethod,
        volumeParam
      );

      if (currentCandle.volume >= volThresholdForBreakout) {
        lastSwingLow.crossed = true;
        const searchRange = klines.slice(lastSwingLow.index, i);

        if (searchRange.length > 0) {
          let bestCandle = null;
          const volThresholdForOB = getVolumeThreshold(
            Math.max(0, lastSwingLow.index - volumeLookback),
            i,
            volumeMethod,
            volumeParam
          );

          for (const candle of searchRange) {
            if (candle.volume >= volThresholdForOB) {
              if (!bestCandle || candle.high > bestCandle.high) {
                bestCandle = candle;
              }
            }
          }

          if (!bestCandle) {
            bestCandle = searchRange.reduce((prev, curr) =>
              prev.high > curr.high ? prev : curr
            );
          }

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
            confidence: bestCandle.volume >= volThresholdForOB ? "high" : "low",
            isValid: true,
            isBroken: false
          });
        }
      }
    }
  }

  return { bullishOBs, bearishOBs };
}

module.exports = {
  findPotentialOrderBlocks
};