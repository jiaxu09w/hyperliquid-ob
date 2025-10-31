// ✅ Appwrite Function 入口
// 所有依赖的代码必须在这个文件或同目录下

const { Client, Databases, Query, ID } = require('node-appwrite');
const axios = require('axios');

// ✅ 导入本地模块（相对路径）
const { findPotentialOrderBlocks } = require('./ob-detector');
const { fetchKlines } = require('./binance');

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log('🔍 Scanner started');

    // ✅ 从环境变量读取配置
    const config = {
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,
      symbol: process.env.TRADING_SYMBOL || 'BTCUSDT',
      timeframe: process.env.ENTRY_TIMEFRAME || '4h'
    };

    // 初始化 Appwrite
    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    // 获取 K 线
    const klines = await fetchKlines(config.symbol, config.timeframe, 100);
    log(`Fetched ${klines.length} klines`);

    // 检测 OB
    const { bullishOBs, bearishOBs } = findPotentialOrderBlocks(
      klines,
      parseInt(process.env.OB_SWING_LENGTH) || 10,
      parseInt(process.env.VOLUME_LOOKBACK) || 20,
      process.env.VOLUME_METHOD || 'percentile',
      parseInt(process.env.VOLUME_PARAM) || 70
    );

    const allOBs = [...bullishOBs, ...bearishOBs];
    log(`Found ${allOBs.length} potential OBs`);

    // 保存新 OB
    const latestIndex = klines.length - 1;
    const newOBs = allOBs.filter(ob => ob.creationIndex >= latestIndex - 2 && ob.isValid);

    let savedCount = 0;
    for (const ob of newOBs) {
      try {
        const existing = await databases.listDocuments(
          config.databaseId,
          'order_blocks',
          [
            Query.equal('symbol', config.symbol),
            Query.equal('confirmationTime', ob.confirmationCandle.timestamp.toISOString()),
            Query.equal('type', ob.type),
            Query.limit(1)
          ]
        );

        if (existing.documents.length === 0) {
          await databases.createDocument(
            config.databaseId,
            'order_blocks',
            ID.unique(),
            {
              symbol: config.symbol,
              timeframe: config.timeframe,
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

    // 更新已有 OB 状态
    const currentPrice = klines[latestIndex].close;
    const activeOBs = await databases.listDocuments(
      config.databaseId,
      'order_blocks',
      [
        Query.equal('symbol', config.symbol),
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
          config.databaseId,
          'order_blocks',
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