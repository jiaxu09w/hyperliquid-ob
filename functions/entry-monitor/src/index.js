/**
 * Entry Monitor - 检查新 OB 并开仓
 */

const { Client, Databases, Query, ID } = require('node-appwrite');
const BinanceAPI = require('./binance');
const HyperliquidAPI = require('./hyperliquid');
const { 
  shouldEnterTrade, 
  calculateStopLoss, 
  calculatePositionSize 
} = require('./strategy');
const { COLLECTIONS, MARKETS } = require('./constants');

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log('📊 Entry Monitor started');

    // ✅ 读取配置
    const config = {
      // Appwrite
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,
      
      // Trading
      symbol: process.env.TRADING_SYMBOL || 'BTCUSDT',
      tradingEnabled: process.env.TRADING_ENABLED === 'true',
      leverage: parseInt(process.env.LEVERAGE) || 3,
      riskPercent: parseFloat(process.env.RISK_PER_TRADE) || 1.5,
      
      // Strategy
      maxOBAge: 12,  // hours
      maxPriceDistance: 0.05,  // 5%
      atrMultiplier: parseFloat(process.env.ATR_SL_MULTIPLIER) || 2.0
    };

    // ✅ 初始化 Appwrite
    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    // ✅ 1. 检查是否已有持仓
    log(`Checking existing positions for ${config.symbol}...`);
    
    const openPositions = await databases.listDocuments(
      config.databaseId,
      COLLECTIONS.POSITIONS,
      [
        Query.equal('symbol', config.symbol),
        Query.equal('status', 'OPEN'),
        Query.limit(1)
      ]
    );

    if (openPositions.documents.length > 0) {
      log('⏭️  Already have open position, skipping');
      return res.json({ 
        success: true, 
        action: 'skipped', 
        reason: 'has_position',
        positionId: openPositions.documents[0].$id
      });
    }

    // ✅ 2. 查找未处理的新 OB
    log('Searching for unprocessed OBs...');
    
    const unprocessedOBs = await databases.listDocuments(
      config.databaseId,
      COLLECTIONS.ORDER_BLOCKS,
      [
        Query.equal('symbol', config.symbol),
        Query.equal('isActive', true),
        Query.equal('isProcessed', false),
        Query.orderDesc('confirmationTime'),
        Query.limit(1)
      ]
    );

    if (unprocessedOBs.documents.length === 0) {
      log('No new OBs to process');
      return res.json({ 
        success: true, 
        action: 'no_signal',
        message: 'No unprocessed OBs found'
      });
    }

    const latestOB = unprocessedOBs.documents[0];
    log(`Found OB: ${latestOB.type} @ ${latestOB.bottom}-${latestOB.top}`);
    log(`   Confirmed: ${latestOB.confirmationTime}`);
    log(`   Confidence: ${latestOB.confidence}`);

    // ✅ 3. 获取当前价格
    const hl = new HyperliquidAPI(
      process.env.HYPERLIQUID_PRIVATE_KEY,
      !config.tradingEnabled  // testMode
    );

    const currentPrice = await hl.getPrice(config.symbol);
    log(`Current price: $${currentPrice.toFixed(2)}`);

    // ✅ 4. 验证 OB 有效性
    const obAge = (Date.now() - new Date(latestOB.confirmationTime)) / (1000 * 60 * 60);
    const priceDistance = latestOB.type === 'BULLISH'
      ? Math.abs(currentPrice - latestOB.top) / latestOB.top
      : Math.abs(currentPrice - latestOB.bottom) / latestOB.bottom;

    log(`OB Age: ${obAge.toFixed(1)}h | Price Distance: ${(priceDistance * 100).toFixed(2)}%`);

    // 检查 OB 年龄
    if (obAge > config.maxOBAge) {
      log(`❌ OB too old (${obAge.toFixed(1)}h > ${config.maxOBAge}h)`);
      
      await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        latestOB.$id,
        {
          isProcessed: true,
          processedAt: new Date().toISOString(),
          processedReason: 'too_old'
        }
      );

      return res.json({
        success: true,
        action: 'skipped',
        reason: 'ob_too_old',
        obAge: obAge.toFixed(1)
      });
    }

    // 检查价格距离
    if (priceDistance > config.maxPriceDistance) {
      log(`❌ Price too far from OB (${(priceDistance * 100).toFixed(2)}% > ${(config.maxPriceDistance * 100).toFixed(2)}%)`);
      
      await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        latestOB.$id,
        {
          isProcessed: true,
          processedAt: new Date().toISOString(),
          processedReason: 'price_too_far'
        }
      );

      return res.json({
        success: true,
        action: 'skipped',
        reason: 'price_too_far',
        distance: (priceDistance * 100).toFixed(2) + '%'
      });
    }

    // ✅ 5. 获取 ATR
    log('Fetching ATR...');
    
    const atrData = await databases.listDocuments(
      config.databaseId,
      COLLECTIONS.MARKET_DATA,
      [
        Query.equal('symbol', config.symbol),
        Query.equal('indicator', 'ATR'),
        Query.orderDesc('timestamp'),
        Query.limit(1)
      ]
    );

    const marketConfig = MARKETS[config.symbol] || MARKETS.BTCUSDT;
    const atr = atrData.documents.length > 0 
      ? atrData.documents[0].value 
      : marketConfig.defaultATR;

    log(`Using ATR: ${atr.toFixed(2)}`);

    // ✅ 6. 计算交易参数
    const side = latestOB.type === 'BULLISH' ? 'LONG' : 'SHORT';
    
    // 止损价格
    const stopLoss = side === 'LONG'
      ? latestOB.bottom - (atr * config.atrMultiplier)
      : latestOB.top + (atr * config.atrMultiplier);

    // 获取余额
    const balance = await hl.getBalance();
    log(`Account balance: $${balance.toFixed(2)}`);

    // 计算仓位大小
    const leveragedBalance = balance * config.leverage;
    const riskAmount = leveragedBalance * (config.riskPercent / 100);
    const riskDistance = Math.abs(currentPrice - stopLoss);
    
    if (riskDistance <= 0) {
      throw new Error('Invalid stop loss distance');
    }
    
    let positionSize = riskAmount / riskDistance;

    // 应用市场规则
    positionSize = Math.floor(positionSize / marketConfig.sizeIncrement) * marketConfig.sizeIncrement;

    if (positionSize < marketConfig.minSize) {
      log(`❌ Position size ${positionSize.toFixed(4)} < min ${marketConfig.minSize}`);
      
      await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        latestOB.$id,
        {
          isProcessed: true,
          processedAt: new Date().toISOString(),
          processedReason: 'size_too_small'
        }
      );

      return res.json({
        success: true,
        action: 'skipped',
        reason: 'size_too_small',
        calculatedSize: positionSize
      });
    }

    log(`\n📋 Trade Plan:`);
    log(`   Side: ${side}`);
    log(`   Size: ${positionSize.toFixed(4)} ${marketConfig.symbol}`);
    log(`   Entry: $${currentPrice.toFixed(2)}`);
    log(`   Stop Loss: $${stopLoss.toFixed(2)}`);
    log(`   Risk: $${riskAmount.toFixed(2)} (${config.riskPercent}% of leveraged balance)`);
    log(`   Leverage: ${config.leverage}x\n`);

    // ✅ 7. 下单
    log(`Placing order (Test Mode: ${!config.tradingEnabled})...`);
    
    const orderResult = await hl.placeOrderWithStopLoss({
      symbol: config.symbol,
      side,
      size: positionSize,
      entryPrice: currentPrice,
      stopLoss
    });

    if (!orderResult.success) {
      error(`❌ Order failed: ${orderResult.error}`);
      
      await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        latestOB.$id,
        {
          isProcessed: true,
          processedAt: new Date().toISOString(),
          processedReason: 'order_failed'
        }
      );

      return res.json({ 
        success: false, 
        error: orderResult.error 
      }, 500);
    }

    log(`✅ Order executed successfully`);
    log(`   Execution Price: $${orderResult.executionPrice.toFixed(2)}`);
    log(`   Executed Size: ${orderResult.executedSize.toFixed(4)}`);
    log(`   Stop Loss Order ID: ${orderResult.stopLossOrderId}`);

    // ✅ 8. 保存持仓记录
    const positionDoc = await databases.createDocument(
      config.databaseId,
      COLLECTIONS.POSITIONS,
      ID.unique(),
      {
        symbol: config.symbol,
        side,
        entryPrice: orderResult.executionPrice,
        avgEntryPrice: orderResult.executionPrice,
        size: orderResult.executedSize,
        stopLoss,
        stopLossOrderId: orderResult.stopLossOrderId,
        liquidationPrice: orderResult.liquidationPrice,
        leverage: config.leverage,
        margin: (orderResult.executionPrice * orderResult.executedSize) / config.leverage,
        status: 'OPEN',
        openTime: new Date().toISOString(),
        relatedOB: latestOB.$id,
        entryFee: orderResult.fee,
        additionCount: 0,
        lastChecked: new Date().toISOString()
      }
    );

    log(`💾 Position saved: ${positionDoc.$id}`);

    // ✅ 9. 标记 OB 已处理
    await databases.updateDocument(
      config.databaseId,
      COLLECTIONS.ORDER_BLOCKS,
      latestOB.$id,
      {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason: 'position_opened'
      }
    );

    const duration = Date.now() - startTime;
    log(`✅ Entry Monitor completed in ${duration}ms`);

    return res.json({
      success: true,
      action: 'position_opened',
      position: {
        id: positionDoc.$id,
        symbol: config.symbol,
        side,
        entryPrice: orderResult.executionPrice,
        size: orderResult.executedSize,
        stopLoss,
        liquidationPrice: orderResult.liquidationPrice
      },
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`Entry monitor error: ${err.message}`);
    error(err.stack);
    
    return res.json({ 
      success: false, 
      error: err.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
};