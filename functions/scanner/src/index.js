/**
 * Scanner v3.2 - 扫描 Order Block（匹配 TradingView）
 * 
 * 新功能：
 * ✅ 自动忽略周末形成的4H OB
 * ✅ 完整的 TradingView 逻辑
 * ✅ ATR 大小限制
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

/**
 * ✅ 检查是否为周末时间
 */
function isWeekendTime(timestamp) {
  const date = new Date(timestamp);
  const dayOfWeek = date.getUTCDay(); // 0=Sunday, 5=Friday, 6=Saturday
  const utcHour = date.getUTCHours();
  
  // 周五 22:00 UTC 之后
  const isFridayNight = dayOfWeek === 5 && utcHour >= 22;
  // 整个周六
  const isSaturday = dayOfWeek === 6;
  // 整个周日
  const isSunday = dayOfWeek === 0;
  
  return isFridayNight || isSaturday || isSunday;
}

// ═════════════════════════════════════════════════════════════════════════
// 主函数
// ═════════════════════════════════════════════════════════════════════════

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log('━'.repeat(60));
    log('🔍 Scanner v3.2 - TradingView Compatible + Weekend Filter');
    log('━'.repeat(60));

    const config = {
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,
      
      symbol: (process.env.TRADING_SYMBOL || 'BTCUSDT').trim().toUpperCase(),
      timeframe: (process.env.ENTRY_TIMEFRAME || '4h').trim().toLowerCase(),
      
      swingLength: parseInt(process.env.OB_SWING_LENGTH) || 10,
      volumeLookback: parseInt(process.env.VOLUME_LOOKBACK) || 20,
      volumeMethod: (process.env.VOLUME_METHOD || 'percentile').trim().toLowerCase(),
      volumeParam: parseInt(process.env.VOLUME_PARAM) || 70,
      
      atrPeriod: parseInt(process.env.ATR_PERIOD) || 10,  // ✅ 改为10（匹配TradingView）
      maxATRMultiplier: parseFloat(process.env.MAX_ATR_MULTIPLIER) || 3.5,
      
      lookbackCandles: parseInt(process.env.LOOKBACK_CANDLES) || 100,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      
      // ✅ 周末过滤（仅4H）
      ignoreWeekendOBs: process.env.IGNORE_WEEKEND_OBS !== 'false'  // 默认启用
    };

    log(`\n⚙️  Configuration:`);
    log(`   Symbol: ${config.symbol}`);
    log(`   Timeframe: ${config.timeframe}`);
    log(`   Swing Length: ${config.swingLength}`);
    log(`   ATR Period: ${config.atrPeriod} (TradingView compatible)`);
    log(`   Ignore Weekend OBs (4H): ${config.ignoreWeekendOBs && config.timeframe === '4h' ? 'Yes' : 'No'}`);

    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);
    const binance = new BinanceAPI();

    // 1️⃣ 获取 K 线数据
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

    // 2️⃣ 计算 ATR
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

    // 3️⃣ 检测 OB
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

    // 4️⃣ 过滤新 OB
    log(`\n4️⃣  Filtering new OBs...`);

    const latestIndex = klines.length - 1;
    const newOBs = allOBs.filter(ob => 
      ob.creationIndex >= latestIndex - 2 && ob.isValid
    );

    log(`   ${newOBs.length} new OBs to process`);

    // 5️⃣ 保存 OB
    log(`\n5️⃣  Saving to database...`);

    let savedCount = 0;
    let skippedCount = 0;
    let weekendSkippedCount = 0;

    for (const ob of newOBs) {
      try {
        // ✅ 周末检测（仅4H）
        const is4H = config.timeframe === '4h';
        const isWeekend = isWeekendTime(ob.confirmationCandle.timestamp);
        
        if (is4H && isWeekend && config.ignoreWeekendOBs) {
          log(`   ⏭️  WEEKEND OB - Auto-ignoring`);
          log(`      Type: ${ob.type} | Time: ${new Date(ob.confirmationCandle.timestamp).toISOString()}`);
          log(`      Range: $${ob.low.toFixed(2)} - $${ob.high.toFixed(2)}`);
          
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
              obCandleTime: ob.obCandle.timestamp.toISOString(),
              createdAt: new Date().toISOString(),
              
              breakoutPrice: ob.confirmationCandle.close,
              confirmationCandleClose: ob.confirmationCandle.close,
              confidence: ob.confidence,
              volume: ob.volume,
              
              isActive: false,
              isBroken: false,
              isProcessed: true,
              processedAt: new Date().toISOString(),
              processedReason: 'weekend_formation',
              
              metadata: JSON.stringify({
                weekendOB: true,
                formationDay: new Date(ob.confirmationCandle.timestamp).getUTCDay(),
                formationTime: ob.confirmationCandle.timestamp.toISOString(),
                reason: 'Formed during weekend no-trade period'
              })
            }
          );
          
          weekendSkippedCount++;
          continue;
        }
        
        // 检查重复
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
              obCandleTime: ob.obCandle.timestamp.toISOString(),
              createdAt: new Date().toISOString(),
              
              breakoutPrice: ob.confirmationCandle.close,
              confirmationCandleClose: ob.confirmationCandle.close,
              confirmationCandleHigh: ob.confirmationCandle.high,
              confirmationCandleLow: ob.confirmationCandle.low,
              confirmationCandleVolume: ob.confirmationCandle.volume,
              
              obCandleHigh: ob.obCandle.high,
              obCandleLow: ob.obCandle.low,
              obCandleOpen: ob.obCandle.open,
              obCandleClose: ob.obCandle.close,
              
              volume: ob.volume,
              obLowVolume: ob.obLowVolume,
              obHighVolume: ob.obHighVolume,
              
              confidence: ob.confidence,
              
              isActive: true,
              isBroken: false,
              isProcessed: false,
              
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
          log(`      Confidence: ${ob.confidence}`);
        } else {
          skippedCount++;
        }
      } catch (saveErr) {
        error(`   ❌ Failed to save OB: ${saveErr.message}`);
      }
    }

    // 6️⃣ 检查已有 OB
    log(`\n6️⃣  Checking existing OBs...`);
    
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

    const duration = Date.now() - startTime;
    
    log(`\n${'━'.repeat(60)}`);
    log(`✅ Scanner completed in ${duration}ms`);
    log(`   New OBs saved: ${savedCount}`);
    log(`   Weekend OBs ignored: ${weekendSkippedCount}`);
    log(`   OBs broken: ${brokenCount}`);
    log(`   Duplicates: ${skippedCount}`);
    log(`${'━'.repeat(60)}\n`);

    return res.json({
      success: true,
      summary: {
        newOBs: savedCount,
        weekendOBsIgnored: weekendSkippedCount,
        brokenOBs: brokenCount,
        duplicates: skippedCount,
        totalOBsChecked: activeOBs.documents.length,
        currentPrice,
        symbol: config.symbol,
        timeframe: config.timeframe,
        atr: currentATR
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