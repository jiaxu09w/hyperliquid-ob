const AppwriteClient = require('../../shared/appwrite-client');
const HyperliquidAPI = require('../../shared/hyperliquid');
const CONFIG = require('../../config/config');

module.exports = async ({ req, res, log, error }) => {
  try {
    log('📊 Entry Monitor started');
    
    const appwrite = new AppwriteClient();
    const symbol = CONFIG.TRADING.SYMBOL;

    // 1. 检查是否已有持仓
    const openPositions = await appwrite.getOpenPositions(symbol);
    if (openPositions.documents.length > 0) {
      log('Already have open position, skipping');
      return res.json({ success: true, action: 'skipped', reason: 'has_position' });
    }

    // 2. 查找未处理的新 OB
    const unprocessedOBs = await appwrite.getUnprocessedOBs(symbol, 1);
    if (unprocessedOBs.documents.length === 0) {
      log('No new OBs to process');
      return res.json({ success: true, action: 'no_signal' });
    }

    const latestOB = unprocessedOBs.documents[0];

    // 3. 初始化 Hyperliquid
    const hl = new HyperliquidAPI(CONFIG.HYPERLIQUID.PRIVATE_KEY);
    const currentPrice = await hl.getPrice(symbol);

    // 4. 验证 OB 有效性
    const obAge = (Date.now() - new Date(latestOB.confirmationTime)) / (1000 * 60 * 60);
    const priceDistance = latestOB.type === 'BULLISH'
      ? Math.abs(currentPrice - latestOB.top) / latestOB.top
      : Math.abs(currentPrice - latestOB.bottom) / latestOB.bottom;

    log(`OB: ${latestOB.type} @ ${latestOB.bottom}-${latestOB.top}`);
    log(`Price: $${currentPrice}, Age: ${obAge.toFixed(2)}h, Distance: ${(priceDistance * 100).toFixed(2)}%`);

    if (obAge > CONFIG.STRATEGY.MAX_OB_AGE_HOURS) {
      await appwrite.updateOB(latestOB.$id, {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason: 'too_old'
      });
      return res.json({ success: true, action: 'skipped', reason: 'ob_too_old' });
    }

    if (priceDistance > CONFIG.STRATEGY.MAX_PRICE_DISTANCE_PERCENT) {
      await appwrite.updateOB(latestOB.$id, {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason: 'price_too_far'
      });
      return res.json({ success: true, action: 'skipped', reason: 'price_too_far' });
    }

    // 5. 计算入场参数
    const side = latestOB.type === 'BULLISH' ? 'LONG' : 'SHORT';
    
    // 获取 ATR
    const atrData = await appwrite.getMarketData(symbol, 'ATR', CONFIG.STRATEGY.TIMEFRAMES.ENTRY);
    const atr = atrData ? atrData.value : 1000;

    // 计算止损
    const stopLoss = side === 'LONG'
      ? latestOB.bottom - (atr * CONFIG.STRATEGY.ATR_SL_MULTIPLIER)
      : latestOB.top + (atr * CONFIG.STRATEGY.ATR_SL_MULTIPLIER);

    // 计算仓位大小
    const balance = await hl.getBalance();
    const leveragedBalance = balance * CONFIG.TRADING.LEVERAGE;
    const riskAmount = leveragedBalance * (CONFIG.TRADING.RISK_PER_TRADE_PERCENT / 100);
    const riskDistance = Math.abs(currentPrice - stopLoss);
    let size = riskAmount / riskDistance;

    // 四舍五入
    size = Math.floor(size * 10000) / 10000;

    if (size < 0.001) {
      await appwrite.updateOB(latestOB.$id, {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason: 'size_too_small'
      });
      return res.json({ success: true, action: 'skipped', reason: 'size_too_small' });
    }

    log(`📊 Opening ${side} position`);
    log(`   Size: ${size} | Entry: $${currentPrice.toFixed(0)} | Stop: $${stopLoss.toFixed(0)}`);

    // 6. 下单
    const orderResult = await hl.placeOrderWithStopLoss({
      symbol,
      side,
      size,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit: null
    });

    if (!orderResult.success) {
      error(`Order failed: ${orderResult.error}`);
      await appwrite.updateOB(latestOB.$id, {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason: 'order_failed'
      });
      return res.json({ success: false, error: orderResult.error }, 500);
    }

    log(`✅ Order executed`);

    // 7. 保存持仓
    const positionDoc = await appwrite.createPosition({
      symbol,
      side,
      entryPrice: orderResult.executionPrice,
      size: orderResult.executedSize,
      stopLoss,
      stopLossOrderId: orderResult.stopLossOrderId,
      liquidationPrice: orderResult.liquidationPrice,
      leverage: CONFIG.TRADING.LEVERAGE,
      margin: (orderResult.executionPrice * orderResult.executedSize) / CONFIG.TRADING.LEVERAGE,
      status: 'OPEN',
      openTime: new Date().toISOString(),
      relatedOB: latestOB.$id,
      entryFee: orderResult.fee,
      lastChecked: new Date().toISOString()
    });

    // 8. 标记 OB 已处理
    await appwrite.updateOB(latestOB.$id, {
      isProcessed: true,
      processedAt: new Date().toISOString(),
      processedReason: 'position_opened'
    });

    await appwrite.log('INFO', `Position opened: ${side} ${size} @ ${orderResult.executionPrice}`, {
      positionId: positionDoc.$id
    });

    return res.json({
      success: true,
      action: 'position_opened',
      positionId: positionDoc.$id,
      side,
      entryPrice: orderResult.executionPrice,
      size: orderResult.executedSize
    });

  } catch (err) {
    error(`Entry monitor error: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};