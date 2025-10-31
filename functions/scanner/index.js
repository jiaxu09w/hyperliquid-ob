// ✅ 在 Appwrite 中，shared 模块需要复制到函数目录
// 或者直接在函数中包含代码

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();
  
  try {
    log('🔍 Scanner started');
    
    // ✅ 从环境变量读取配置
    const CONFIG = {
      APPWRITE: {
        ENDPOINT: process.env.APPWRITE_ENDPOINT,
        PROJECT_ID: process.env.APPWRITE_PROJECT_ID,
        API_KEY: process.env.APPWRITE_API_KEY,
        DATABASE_ID: process.env.APPWRITE_DATABASE_ID,
        COLLECTIONS: {
          ORDER_BLOCKS: 'order_blocks',
          SYSTEM_STATE: 'system_state'
        }
      },
      TRADING: {
        SYMBOL: process.env.TRADING_SYMBOL || 'BTCUSDT'
      },
      STRATEGY: {
        OB_SWING_LENGTH: parseInt(process.env.OB_SWING_LENGTH) || 10,
        VOLUME_LOOKBACK: parseInt(process.env.VOLUME_LOOKBACK) || 20,
        VOLUME_METHOD: process.env.VOLUME_METHOD || 'percentile',
        VOLUME_PARAM: parseInt(process.env.VOLUME_PARAM) || 70,
        TIMEFRAMES: {
          ENTRY: process.env.ENTRY_TIMEFRAME || '4h'
        }
      }
    };

    // ✅ 导入依赖（在 Appwrite 环境中）
    const { Client, Databases, Query, ID } = require('node-appwrite');
    const axios = require('axios');

    // ✅ 初始化 Appwrite Client
    const client = new Client()
      .setEndpoint(CONFIG.APPWRITE.ENDPOINT)
      .setProject(CONFIG.APPWRITE.PROJECT_ID)
      .setKey(CONFIG.APPWRITE.API_KEY);

    const databases = new Databases(client);
    const dbId = CONFIG.APPWRITE.DATABASE_ID;

    // ✅ 获取 K 线数据（直接调用 Binance API）
    const symbol = CONFIG.TRADING.SYMBOL;
    const timeframe = CONFIG.STRATEGY.TIMEFRAMES.ENTRY;
    const limit = 100;

    const binanceResponse = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol, interval: timeframe, limit },
      timeout: 10000
    });

    const klines = binanceResponse.data.map((k, index) => ({
      timestamp: new Date(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      index
    }));

    log(`Fetched ${klines.length} klines for ${symbol} ${timeframe}`);

    // ✅ OB 检测逻辑（内联实现）
    const { bullishOBs, bearishOBs } = findPotentialOrderBlocks(
      klines,
      CONFIG.STRATEGY.OB_SWING_LENGTH,
      CONFIG.STRATEGY.VOLUME_LOOKBACK,
      CONFIG.STRATEGY.VOLUME_METHOD,
      CONFIG.STRATEGY.VOLUME_PARAM
    );

    const allOBs = [...bullishOBs, ...bearishOBs];
    log(`Found ${allOBs.length} potential OBs`);

    // ✅ 只保存最新形成的 OB
    const latestIndex = klines.length - 1;
    const newOBs = allOBs.filter(ob => ob.creationIndex >= latestIndex - 2 && ob.isValid);

    let savedCount = 0;
    for (const ob of newOBs) {
      try {
        // 检查是否已存在
        const existing = await databases.listDocuments(
          dbId,
          CONFIG.APPWRITE.COLLECTIONS.ORDER_BLOCKS,
          [
            Query.equal('symbol', symbol),
            Query.equal('confirmationTime', ob.confirmationCandle.timestamp.toISOString()),
            Query.equal('type', ob.type),
            Query.limit(1)
          ]
        );

        if (existing.documents.length === 0) {
          await databases.createDocument(
            dbId,
            CONFIG.APPWRITE.COLLECTIONS.ORDER_BLOCKS,
            ID.unique(),
            {
              symbol,
              timeframe,
              type: ob.type,
              top: ob.high,
              bottom: ob.low,
              confirmationTime: ob.confirmationCandle.timestamp.toISOString(),
              confidence: ob.confidence,
              volume: ob.volume,
              isActive: true,
              isBroken: false,
              isProcessed: false,
              createdAt: new Date().toISOString()
            }
          );
          savedCount++;
          log(`✅ Saved ${ob.type} OB @ ${ob.low}-${ob.high}`);
        }
      } catch (err) {
        error(`Failed to save OB: ${err.message}`);
      }
    }

    // ✅ 更新已有 OB 的状态
    const currentPrice = klines[latestIndex].close;
    const activeOBs = await databases.listDocuments(
      dbId,
      CONFIG.APPWRITE.COLLECTIONS.ORDER_BLOCKS,
      [
        Query.equal('symbol', symbol),
        Query.equal('isActive', true),
        Query.limit(100)
      ]
    );

    let brokenCount = 0;
    for (const obDoc of activeOBs.documents || []) {
      const isBroken =
        (obDoc.type === 'BULLISH' && currentPrice < obDoc.bottom) ||
        (obDoc.type === 'BEARISH' && currentPrice > obDoc.top);

      if (isBroken) {
        await databases.updateDocument(
          dbId,
          CONFIG.APPWRITE.COLLECTIONS.ORDER_BLOCKS,
          obDoc.$id,
          {
            isActive: false,
            isBroken: true,
            brokenAt: new Date().toISOString(),
            brokenPrice: currentPrice
          }
        );
        brokenCount++;
        log(`❌ OB ${obDoc.$id} broken`);
      }
    }

    const duration = Date.now() - startTime;
    log(`✅ Scanner completed in ${duration}ms`);

    return res.json({
      success: true,
      newOBs: savedCount,
      brokenOBs: brokenCount,
      currentPrice,
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`Scanner error: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};

// ✅ OB 检测函数（内联实现，避免依赖外部文件）
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