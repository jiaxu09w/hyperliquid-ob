/**
 * Scanner Function v3.0 - 扫描 Order Block（匹配 TradingView 逻辑）
 * 
 * 改进：
 * ✅ 匹配 TradingView 的 OB 检测逻辑
 * ✅ ATR 大小限制
 * ✅ 3 根蜡烛成交量累加
 * ✅ 保存突破价格
 * ✅ API 错误处理
 * ✅ 参数清理
 */

const { Client, Databases, Query, ID } = require('node-appwrite');
const { ATR } = require('technicalindicators');
const BinanceAPI = require('./binance');
const { findPotentialOrderBlocks } = require('./ob-detector');
const { COLLECTIONS } = require('./constants');

// ═════════════════════════════════════════════════════════════════════════
// 工具函数
// ═════════════════════════════════════════════════════════════════════════

async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000, fnName = 'Operation') {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      
      const delay = initialDelay * Math.pow(2, i);
      console.log(`⚠️  ${fnName} failed (attempt ${i + 1}/${maxRetries}), retrying in ${delay}ms...`);
      console.log(`   Error: ${err.message}`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 主函数
// ═════════════════════════════════════════════════════════════════════════

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log('━'.repeat(60));
    log('🔍 Scanner v3.0 - TradingView Compatible');
    log('━'.repeat(60));

    // ═══════════════════════════════════════════════════════════════════════
    // 配置
    // ═══════════════════════════════════════════════════════════════════════
    
    const config = {
      // Appwrite
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,
      
      // Trading pairs
      symbol: (process.env.TRADING_SYMBOL || 'BTCUSDT').trim().toUpperCase(),
      timeframe: (process.env.ENTRY_TIMEFRAME || '4h').trim().toLowerCase(),
      
      // OB Detection
      swingLength: parseInt(process.env.OB_SWING_LENGTH) || 10,
      volumeLookback: parseInt(process.env.VOLUME_LOOKBACK) || 20,
      volumeMethod: (process.env.VOLUME_METHOD || 'percentile').trim().toLowerCase(),
      volumeParam: parseInt(process.env.VOLUME_PARAM) || 70,
      
      // ATR
      atrPeriod: parseInt(process.env.ATR_PERIOD) || 14,
      maxATRMultiplier: parseFloat(process.env.MAX_ATR_MULTIPLIER) || 3.5,
      
      // Data
      lookbackCandles: parseInt(process.env.LOOKBACK_CANDLES) || 100,
      
      // API
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3
    };

    log(`\n⚙️  Configuration:`);
    log(`   Symbol: ${config.symbol}`);
    log(`   Timeframe: ${config.timeframe}`);
    log(`   Swing Length: ${config.swingLength}`);
    log(`   Volume Method: ${config.volumeMethod} (${config.volumeParam})`);
    log(`   Max ATR Multiplier: ${config.maxATRMultiplier}x`);

    // ═══════════════════════════════════════════════════════════════════════
    // 初始化
    // ═══════════════════════════════════════════════════════════════════════
    
    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);
    const binance = new BinanceAPI();

    // ═══════════════════════════════════════════════════════════════════════
    // 1. 获取 K 线数据
    // ═══════════════════════════════════════════════════════════════════════
    
    log(`\n1️⃣  Fetching klines...`);
    
    const klines = await retryWithBackoff(
      () => binance.getRecentKlines(config.symbol, config.timeframe, config.lookbackCandles),
      config.maxRetries,
      2000,
      'Fetch klines'
    );

    if (!klines || klines.length === 0) {
      throw new Error('No klines data received');
    }

    log(`   ✅ Fetched ${klines.length} klines`);
    log(`   Latest: ${new Date(klines[klines.length - 1].timestamp).toISOString()}`);
    log(`   Price: $${klines[klines.length - 1].close.toFixed(2)}`);

    // ═══════════════════════════════════════════════════════════════════════
    // 2. 计算 ATR
    // ═══════════════════════════════════════════════════════════════════════
    
    log(`\n2️⃣  Calculating ATR...`);

    const atrValues = ATR.calculate({
      high: klines.map(k => k.high),
      low: klines.map(k => k.low),
      close: klines.map(k => k.close),
      period: config.atrPeriod
    });

    const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : null;

    if (currentATR) {
      log(`   ✅ ATR(${config.atrPeriod}): ${currentATR.toFixed(2)}`);
      log(`   Max OB size: ${(currentATR * config.maxATRMultiplier).toFixed(2)}`);
    } else {
      log(`   ⚠️  ATR not available (insufficient data)`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. 检测 OB
    // ═══════════════════════════════════════════════════════════════════════
    
    log(`\n3️⃣  Detecting Order Blocks...`);

    const { bullishOBs, bearishOBs } = findPotentialOrderBlocks(
      klines,
      config.swingLength,
      config.volumeLookback,
      config.volumeMethod,
      config.volumeParam,
      config.maxATRMultiplier,
      currentATR
    );

    const allOBs = [...bullishOBs, ...bearishOBs];
    log(`   Found ${allOBs.length} potential OBs`);
    log(`   ├─ Bullish: ${bullishOBs.length}`);
    log(`   └─ Bearish: ${bearishOBs.length}`);

    // ═══════════════════════════════════════════════════════════════════════
    // 4. 过滤新形成的 OB（最近 2 根蜡烛）
    // ═══════════════════════════════════════════════════════════════════════
    
    log(`\n4️⃣  Filtering new OBs...`);

    const latestIndex = klines.length - 1;
    const newOBs = allOBs.filter(ob => 
      ob.creationIndex >= latestIndex - 2 && ob.isValid
    );

    log(`   ${newOBs.length} new OBs to process`);

    // ═══════════════════════════════════════════════════════════════════════
    // 5. 保存新 OB 到数据库
    // ═══════════════════════════════════════════════════════════════════════
    
    log(`\n5️⃣  Saving to database...`);

    let savedCount = 0;
    let skippedCount = 0;

    for (const ob of newOBs) {
      try {
        // 检查是否已存在（避免重复）
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
          const obDoc = await databases.createDocument(
            config.databaseId,
            COLLECTIONS.ORDER_BLOCKS,
            ID.unique(),
            {
              // 基本信息
              symbol: config.symbol,
              timeframe: config.timeframe,
              type: ob.type,
              top: ob.high,
              bottom: ob.low,
              
              // 时间戳
              confirmationTime: ob.confirmationCandle.timestamp.toISOString(),
              obCandleTime: ob.obCandle.timestamp.toISOString(),
              createdAt: new Date().toISOString(),
              
              // ✅ 突破价格（用于入场）
              breakoutPrice: ob.confirmationCandle.close,
              confirmationCandleClose: ob.confirmationCandle.close,
              confirmationCandleHigh: ob.confirmationCandle.high,
              confirmationCandleLow: ob.confirmationCandle.low,
              confirmationCandleVolume: ob.confirmationCandle.volume,
              
              // ✅ OB 蜡烛信息
              obCandleHigh: ob.obCandle.high,
              obCandleLow: ob.obCandle.low,
              obCandleOpen: ob.obCandle.open,
              obCandleClose: ob.obCandle.close,
              
              // ✅ 成交量信息（3根蜡烛）
              volume: ob.volume,
              obLowVolume: ob.obLowVolume,
              obHighVolume: ob.obHighVolume,
              
              // 置信度
              confidence: ob.confidence,
              
              // 状态
              isActive: true,
              isBroken: false,
              isProcessed: false,
              
              // 元数据
              metadata: JSON.stringify({
                swingLength: config.swingLength,
                volumeMethod: config.volumeMethod,
                volumeParam: config.volumeParam,
                atr: currentATR,
                obSize: Math.abs(ob.high - ob.low),
                obSizeATRRatio: currentATR ? (Math.abs(ob.high - ob.low) / currentATR) : null
              })
            }
          );
          
          savedCount++;
          log(`   ✅ Saved ${ob.type} OB @ $${ob.low.toFixed(2)}-$${ob.high.toFixed(2)}`);
          log(`      Breakout: $${ob.confirmationCandle.close.toFixed(2)}`);
          log(`      Volume: ${ob.volume.toFixed(0)} (H:${ob.obHighVolume.toFixed(0)} / L:${ob.obLowVolume.toFixed(0)})`);
          log(`      Confidence: ${ob.confidence}`);
        } else {
          skippedCount++;
          log(`   ⏭️  Skipped duplicate OB @ ${ob.confirmationCandle.timestamp.toISOString()}`);
        }
      } catch (saveErr) {
        error(`   ❌ Failed to save OB: ${saveErr.message}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. 更新已有 OB 的状态（检查是否被突破）
    // ═══════════════════════════════════════════════════════════════════════
    
    log(`\n6️⃣  Checking existing OBs for breaks...`);
    
    const currentPrice = klines[latestIndex].close;
    const currentLow = klines[latestIndex].low;
    const currentHigh = klines[latestIndex].high;
    
    const activeOBs = await retryWithBackoff(
      () => databases.listDocuments(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        [
          Query.equal('symbol', config.symbol),
          Query.equal('isActive', true),
          Query.limit(100)
        ]
      ),
      3,
      1000,
      'List active OBs'
    );

    let brokenCount = 0;
    
    for (const obDoc of activeOBs.documents || []) {
      // ✅ 使用收盘价或最低/最高价检查（根据配置）
      const useWick = process.env.OB_INVALIDATION_METHOD !== 'close';
      
      const isBroken = obDoc.type === 'BULLISH'
        ? (useWick ? currentLow : currentPrice) < obDoc.bottom
        : (useWick ? currentHigh : currentPrice) > obDoc.top;

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
        log(`   ❌ OB ${obDoc.$id.substring(0, 8)} broken at $${currentPrice.toFixed(2)}`);
      }
    }

    if (brokenCount === 0) {
      log(`   ✅ No OBs broken`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 完成
    // ═══════════════════════════════════════════════════════════════════════
    
    const duration = Date.now() - startTime;
    
    log(`\n${'━'.repeat(60)}`);
    log(`✅ Scanner completed in ${duration}ms`);
    log(`   New OBs: ${savedCount}`);
    log(`   Broken OBs: ${brokenCount}`);
    log(`   Duplicates: ${skippedCount}`);
    log(`${'━'.repeat(60)}\n`);

    return res.json({
      success: true,
      summary: {
        newOBs: savedCount,
        brokenOBs: brokenCount,
        duplicates: skippedCount,
        totalOBsChecked: activeOBs.documents.length,
        currentPrice,
        symbol: config.symbol,
        timeframe: config.timeframe,
        atr: currentATR
      },
      details: {
        bullishOBs: bullishOBs.length,
        bearishOBs: bearishOBs.length,
        totalDetected: allOBs.length,
        newOBsDetected: newOBs.length
      },
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`\n❌ Scanner error: ${err.message}`);
    error(err.stack);
    
    return res.json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
};