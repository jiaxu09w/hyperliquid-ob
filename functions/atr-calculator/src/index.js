/**
 * ATR Calculator - 计算并保存 ATR 指标
 */

const { Client, Databases, ID } = require('node-appwrite');
const { ATR } = require('technicalindicators');
const BinanceAPI = require('./binance');
const { COLLECTIONS } = require('./constants');

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log('📈 ATR Calculator started');

    // ✅ 配置
    const config = {
      // Appwrite
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,
      
      // Symbols to calculate
      symbols: (process.env.TRADING_SYMBOL || 'BTCUSDT,ETHUSDT').split(','),
      
      // Timeframes to calculate (should match entry timeframe)
      timeframes: (process.env.ATR_TIMEFRAMES || '4h,1d').split(','),
      
      // ATR settings
      atrPeriod: parseInt(process.env.ATR_PERIOD) || 14,
      lookbackCandles: 100,  // 获取足够的数据来计算 ATR
    };

    // ✅ 初始化 Appwrite
    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    // ✅ 初始化 Binance API
    const binance = new BinanceAPI();

    const results = [];

    // ✅ 为每个交易对和时间框架计算 ATR
    for (const symbol of config.symbols) {
      const cleanSymbol = symbol.trim();
      log(`\n--- Processing ${cleanSymbol} ---`);

      for (const timeframe of config.timeframes) {
        const cleanTf = timeframe.trim();
        log(`Calculating ATR for ${cleanSymbol} ${cleanTf}...`);

        try {
          // 1. 获取 K 线数据
          const klines = await binance.getRecentKlines(
            cleanSymbol, 
            cleanTf, 
            config.lookbackCandles
          );

          if (!klines || klines.length < config.atrPeriod) {
            log(`⚠️  Insufficient data for ${cleanSymbol} ${cleanTf} (got ${klines?.length || 0}, need ${config.atrPeriod})`);
            continue;
          }

          log(`   Fetched ${klines.length} klines`);

          // 2. 计算 ATR
          const atrInput = {
            high: klines.map(k => k.high),
            low: klines.map(k => k.low),
            close: klines.map(k => k.close),
            period: config.atrPeriod
          };

          const atrValues = ATR.calculate(atrInput);

          if (!atrValues || atrValues.length === 0) {
            log(`⚠️  ATR calculation failed for ${cleanSymbol} ${cleanTf}`);
            continue;
          }

          const latestATR = atrValues[atrValues.length - 1];
          const latestCandle = klines[klines.length - 1];

          log(`   Latest ATR: ${latestATR.toFixed(2)}`);
          log(`   Latest Price: $${latestCandle.close.toFixed(2)}`);
          log(`   ATR %: ${((latestATR / latestCandle.close) * 100).toFixed(2)}%`);

          // 3. 检查是否已存在最近的记录
          const existingRecords = await databases.listDocuments(
            config.databaseId,
            COLLECTIONS.MARKET_DATA,
            [
              require('node-appwrite').Query.equal('symbol', cleanSymbol),
              require('node-appwrite').Query.equal('indicator', 'ATR'),
              require('node-appwrite').Query.equal('timeframe', cleanTf),
              require('node-appwrite').Query.orderDesc('timestamp'),
              require('node-appwrite').Query.limit(1)
            ]
          );

          // 检查是否需要更新（避免重复插入）
          let shouldSave = true;
          if (existingRecords.documents.length > 0) {
            const lastRecord = existingRecords.documents[0];
            const lastRecordTime = new Date(lastRecord.timestamp);
            const currentTime = latestCandle.timestamp;
            
            // 如果上次记录的时间和当前蜡烛时间相同，则更新而不是插入
            const timeDiff = Math.abs(currentTime - lastRecordTime) / (1000 * 60 * 60);
            
            if (timeDiff < 1) {  // 1小时内
              log(`   Updating existing record (last update: ${lastRecordTime.toISOString()})`);
              
              await databases.updateDocument(
                config.databaseId,
                COLLECTIONS.MARKET_DATA,
                lastRecord.$id,
                {
                  value: latestATR,
                  timestamp: currentTime.toISOString(),
                  metadata: JSON.stringify({
                    period: config.atrPeriod,
                    candleClose: latestCandle.close,
                    atrPercent: (latestATR / latestCandle.close) * 100,
                    calculatedAt: new Date().toISOString()
                  })
                }
              );
              
              shouldSave = false;
            }
          }

          // 4. 保存新记录
          if (shouldSave) {
            await databases.createDocument(
              config.databaseId,
              COLLECTIONS.MARKET_DATA,
              ID.unique(),
              {
                symbol: cleanSymbol,
                indicator: 'ATR',
                timeframe: cleanTf,
                value: latestATR,
                timestamp: latestCandle.timestamp.toISOString(),
                metadata: JSON.stringify({
                  period: config.atrPeriod,
                  candleClose: latestCandle.close,
                  atrPercent: (latestATR / latestCandle.close) * 100,
                  calculatedAt: new Date().toISOString()
                })
              }
            );
            
            log(`   ✅ Saved ATR to database`);
          } else {
            log(`   ✅ Updated existing ATR record`);
          }

          results.push({
            symbol: cleanSymbol,
            timeframe: cleanTf,
            atr: latestATR,
            price: latestCandle.close,
            atrPercent: ((latestATR / latestCandle.close) * 100).toFixed(2),
            timestamp: latestCandle.timestamp.toISOString()
          });

        } catch (err) {
          error(`Error calculating ATR for ${cleanSymbol} ${cleanTf}: ${err.message}`);
          results.push({
            symbol: cleanSymbol,
            timeframe: cleanTf,
            error: err.message
          });
        }
      }
    }

    const duration = Date.now() - startTime;
    log(`\n✅ ATR Calculator completed in ${duration}ms`);
    
    // ✅ 汇总统计
    const successful = results.filter(r => !r.error).length;
    const failed = results.filter(r => r.error).length;
    
    log(`\n📊 Summary: ${successful} successful, ${failed} failed`);

    return res.json({
      success: true,
      summary: {
        totalCalculations: results.length,
        successful,
        failed
      },
      results,
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`ATR Calculator error: ${err.message}`);
    error(err.stack);
    
    return res.json({ 
      success: false, 
      error: err.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
};