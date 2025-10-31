/**
 * Scanner Function - 扫描 Order Block
 */

const { Client, Databases, Query, ID } = require('node-appwrite');
const BinanceAPI = require('./binance');
const { findPotentialOrderBlocks } = require('./ob-detector');
const { COLLECTIONS } = require('./constants');

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
      timeframe: process.env.ENTRY_TIMEFRAME || '4h',
      swingLength: parseInt(process.env.OB_SWING_LENGTH) || 10,
      volumeLookback: parseInt(process.env.VOLUME_LOOKBACK) || 20,
      volumeMethod: process.env.VOLUME_METHOD || 'percentile',
      volumeParam: parseInt(process.env.VOLUME_PARAM) || 70
    };

    // ✅ 初始化 Appwrite Client
    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    // ✅ 初始化 Binance API
    const binance = new BinanceAPI();
    
    // ✅ 获取 K 线数据
    log(`Fetching ${config.timeframe} klines for ${config.symbol}...`);
    const klines = await binance.getRecentKlines(config.symbol, config.timeframe, 100);
    log(`Fetched ${klines.length} klines`);

    if (klines.length === 0) {
      throw new Error('No klines data received');
    }

    // ✅ 检测 OB
    log('Detecting Order Blocks...');
    const { bullishOBs, bearishOBs } = findPotentialOrderBlocks(
      klines,
      config.swingLength,
      config.volumeLookback,
      config.volumeMethod,
      config.volumeParam
    );

    const allOBs = [...bullishOBs, ...bearishOBs];
    log(`Found ${allOBs.length} potential OBs (${bullishOBs.length} bullish, ${bearishOBs.length} bearish)`);

    // ✅ 只保存最新形成的 OB（最近 2 根 K 线内）
    const latestIndex = klines.length - 1;
    const newOBs = allOBs.filter(ob => 
      ob.creationIndex >= latestIndex - 2 && ob.isValid
    );

    log(`Processing ${newOBs.length} new OBs...`);

    let savedCount = 0;
    for (const ob of newOBs) {
      try {
        // 检查是否已存在（避免重复保存）
        const existing = await databases.listDocuments(
          config.databaseId,
          COLLECTIONS.ORDER_BLOCKS,
          [
            Query.equal('symbol', config.symbol),
            Query.equal('confirmationTime', ob.confirmationCandle.timestamp.toISOString()),
            Query.equal('type', ob.type),
            Query.limit(1)
          ]
        );

        if (existing.documents.length === 0) {
          // 保存新 OB
          await databases.createDocument(
            config.databaseId,
            COLLECTIONS.ORDER_BLOCKS,
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
          log(`✅ Saved ${ob.type} OB @ ${ob.low.toFixed(2)}-${ob.high.toFixed(2)}`);
        }
      } catch (saveErr) {
        error(`Failed to save OB: ${saveErr.message}`);
      }
    }

    // ✅ 更新已有 OB 的状态（检查是否被突破）
    log('Checking existing OBs for breaks...');
    const currentPrice = klines[latestIndex].close;
    
    const activeOBs = await databases.listDocuments(
      config.databaseId,
      COLLECTIONS.ORDER_BLOCKS,
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
          COLLECTIONS.ORDER_BLOCKS,
          obDoc.$id,
          {
            isActive: false,
            isBroken: true,
            brokenAt: new Date().toISOString(),
            brokenPrice: currentPrice
          }
        );
        brokenCount++;
        log(`❌ OB ${obDoc.$id.substring(0, 8)} broken at ${currentPrice.toFixed(2)}`);
      }
    }

    const duration = Date.now() - startTime;
    log(`✅ Scanner completed in ${duration}ms`);

    return res.json({
      success: true,
      summary: {
        newOBs: savedCount,
        brokenOBs: brokenCount,
        totalOBsChecked: activeOBs.documents.length,
        currentPrice,
        symbol: config.symbol,
        timeframe: config.timeframe
      },
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`Scanner error: ${err.message}`);
    error(err.stack);
    
    return res.json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
};