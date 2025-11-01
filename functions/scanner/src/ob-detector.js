/**
 * Order Block 检测逻辑（完全匹配 TradingView）
 */

const { OB_TYPE } = require('./constants');

/**
 * 检测潜在的 Order Blocks
 */
function findPotentialOrderBlocks(
  klines,
  swingLength = 10,
  volumeLookback = 20,
  volumeMethod = 'percentile',
  volumeParam = 70,
  maxATRMultiplier = 3.5,
  atr = null
) {
  let bullishOBs = [];
  let bearishOBs = [];
  let lastSwingHigh = null;
  let lastSwingLow = null;

  /**
   * 计算成交量阈值
   */
  function getVolumeThreshold(startIndex, endIndex, method, param) {
    const vols = klines
      .slice(startIndex, endIndex)
      .map(k => k.volume)
      .filter(v => v > 0);

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

  // 主循环
  for (let i = swingLength; i < klines.length; i++) {
    const refIndex = i - swingLength;
    const windowSlice = klines.slice(refIndex + 1, i + 1);

    if (windowSlice.length === 0) continue;

    // 寻找波段高点
    const maxHighInWindow = Math.max(...windowSlice.map(c => c.high));
    if (klines[refIndex].high > maxHighInWindow) {
      lastSwingHigh = { ...klines[refIndex], index: refIndex, crossed: false };
    }

    // 寻找波段低点
    const minLowInWindow = Math.min(...windowSlice.map(c => c.low));
    if (klines[refIndex].low < minLowInWindow) {
      lastSwingLow = { ...klines[refIndex], index: refIndex, crossed: false };
    }

    const currentCandle = klines[i];

    // ═══════════════════════════════════════════════════════════════════════
    // 看涨 OB 识别（TradingView 逻辑）
    // ═══════════════════════════════════════════════════════════════════════
    
    if (lastSwingHigh && !lastSwingHigh.crossed && currentCandle.close > lastSwingHigh.high) {
      // 可选：成交量过滤
      const useVolumeFilter = volumeParam > 0;
      let shouldCreateOB = true;
      
      if (useVolumeFilter) {
        const volThreshold = getVolumeThreshold(
          Math.max(0, i - volumeLookback),
          i,
          volumeMethod,
          volumeParam
        );
        shouldCreateOB = currentCandle.volume >= volThreshold;
      }

      if (shouldCreateOB) {
        lastSwingHigh.crossed = true;
        const searchRange = klines.slice(lastSwingHigh.index, i);

        if (searchRange.length > 0) {
          // ✅ TradingView 逻辑：找最低点的蜡烛
          let boxBottom = Math.min(searchRange[0].open, searchRange[0].close);
          let boxTop = Math.max(searchRange[0].open, searchRange[0].close);
          let boxIndex = 0;

          for (let j = 0; j < searchRange.length; j++) {
            const candle = searchRange[j];
            const candleMin = Math.min(candle.open, candle.close);
            const candleMax = Math.max(candle.open, candle.close);
            
            if (candleMin < boxBottom) {
              boxBottom = candleMin;
              boxTop = candleMax;
              boxIndex = j;
            }
          }

          const obCandle = searchRange[boxIndex];
          
          // ✅ 成交量：3 根蜡烛总和
          const totalVolume = currentCandle.volume 
            + (i >= 1 ? klines[i - 1].volume : 0) 
            + (i >= 2 ? klines[i - 2].volume : 0);
          
          const obLowVolume = i >= 2 ? klines[i - 2].volume : 0;
          const obHighVolume = currentCandle.volume + (i >= 1 ? klines[i - 1].volume : 0);

          // 置信度
          const volThresholdForConfidence = useVolumeFilter 
            ? getVolumeThreshold(
                Math.max(0, lastSwingHigh.index - volumeLookback),
                i,
                volumeMethod,
                volumeParam
              )
            : 0;
          
          const confidence = obCandle.volume >= volThresholdForConfidence ? 'high' : 'low';

          // ✅ ATR 大小限制
          const obSize = Math.abs(boxTop - boxBottom);
          const passesATRCheck = !atr || (obSize <= atr * maxATRMultiplier);

          if (passesATRCheck) {
            bullishOBs.push({
              high: boxTop,
              low: boxBottom,
              type: OB_TYPE.BULLISH,
              creationIndex: i,
              confirmationCandle: {
                index: i,
                timestamp: currentCandle.timestamp,
                close: currentCandle.close,
                high: currentCandle.high,
                low: currentCandle.low,
                volume: currentCandle.volume
              },
              obCandle: {
                timestamp: obCandle.timestamp,
                high: obCandle.high,
                low: obCandle.low,
                open: obCandle.open,
                close: obCandle.close,
                volume: obCandle.volume
              },
              volume: totalVolume,
              obLowVolume,
              obHighVolume,
              confidence,
              isValid: true,
              isBroken: false
            });
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 看跌 OB 识别（TradingView 逻辑）
    // ═══════════════════════════════════════════════════════════════════════
    
    if (lastSwingLow && !lastSwingLow.crossed && currentCandle.close < lastSwingLow.low) {
      const useVolumeFilter = volumeParam > 0;
      let shouldCreateOB = true;
      
      if (useVolumeFilter) {
        const volThreshold = getVolumeThreshold(
          Math.max(0, i - volumeLookback),
          i,
          volumeMethod,
          volumeParam
        );
        shouldCreateOB = currentCandle.volume >= volThreshold;
      }

      if (shouldCreateOB) {
        lastSwingLow.crossed = true;
        const searchRange = klines.slice(lastSwingLow.index, i);

        if (searchRange.length > 0) {
          // ✅ TradingView 逻辑：找最高点的蜡烛
          let boxTop = Math.max(searchRange[0].open, searchRange[0].close);
          let boxBottom = Math.min(searchRange[0].open, searchRange[0].close);
          let boxIndex = 0;

          for (let j = 0; j < searchRange.length; j++) {
            const candle = searchRange[j];
            const candleMax = Math.max(candle.open, candle.close);
            const candleMin = Math.min(candle.open, candle.close);
            
            if (candleMax > boxTop) {
              boxTop = candleMax;
              boxBottom = candleMin;
              boxIndex = j;
            }
          }

          const obCandle = searchRange[boxIndex];
          
          const totalVolume = currentCandle.volume 
            + (i >= 1 ? klines[i - 1].volume : 0) 
            + (i >= 2 ? klines[i - 2].volume : 0);
          
          const obLowVolume = currentCandle.volume + (i >= 1 ? klines[i - 1].volume : 0);
          const obHighVolume = i >= 2 ? klines[i - 2].volume : 0;

          const volThresholdForConfidence = useVolumeFilter
            ? getVolumeThreshold(
                Math.max(0, lastSwingLow.index - volumeLookback),
                i,
                volumeMethod,
                volumeParam
              )
            : 0;
          
          const confidence = obCandle.volume >= volThresholdForConfidence ? 'high' : 'low';

          const obSize = Math.abs(boxTop - boxBottom);
          const passesATRCheck = !atr || (obSize <= atr * maxATRMultiplier);

          if (passesATRCheck) {
            bearishOBs.push({
              high: boxTop,
              low: boxBottom,
              type: OB_TYPE.BEARISH,
              creationIndex: i,
              confirmationCandle: {
                index: i,
                timestamp: currentCandle.timestamp,
                close: currentCandle.close,
                high: currentCandle.high,
                low: currentCandle.low,
                volume: currentCandle.volume
              },
              obCandle: {
                timestamp: obCandle.timestamp,
                high: obCandle.high,
                low: obCandle.low,
                open: obCandle.open,
                close: obCandle.close,
                volume: obCandle.volume
              },
              volume: totalVolume,
              obLowVolume,
              obHighVolume,
              confidence,
              isValid: true,
              isBroken: false
            });
          }
        }
      }
    }
  }

  return { bullishOBs, bearishOBs };
}

module.exports = {
  findPotentialOrderBlocks
};