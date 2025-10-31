const AppwriteClient = require('../../shared/appwrite-client');
const HyperliquidAPI = require('../../shared/hyperliquid');
const CONFIG = require('../../config/config');

module.exports = async ({ req, res, log, error }) => {
  try {
    log('👀 Position Monitor started');
    
    const appwrite = new AppwriteClient();
    const symbol = CONFIG.TRADING.SYMBOL;

    // 1. 获取所有未平仓位
    const openPositions = await appwrite.getOpenPositions(symbol);
    if (openPositions.documents.length === 0) {
      return res.json({ success: true, action: 'no_positions' });
    }

    const hl = new HyperliquidAPI(CONFIG.HYPERLIQUID.PRIVATE_KEY);
    const currentPrice = await hl.getPrice(symbol);

    log(`Checking ${openPositions.documents.length} positions @ $${currentPrice}`);

    const results = [];

    for (const posDoc of openPositions.documents) {
      log(`Position ${posDoc.$id}: ${posDoc.side} @ $${posDoc.entryPrice}`);

      // 1. 验证持仓是否仍存在
      const livePosition = await hl.getPosition(symbol.replace('USDT', ''));

      if (!livePosition || (livePosition.szi !== undefined && Math.abs(livePosition.szi) === 0)) {
        log(`⚠️ Position stopped out`);

        await appwrite.updatePosition(posDoc.$id, {
          status: 'CLOSED',
          exitTime: new Date().toISOString(),
          exitReason: 'STOP_LOSS_TRIGGERED',
          exitPrice: posDoc.stopLoss,
          pnl: posDoc.side === 'LONG'
            ? (posDoc.stopLoss - posDoc.entryPrice) * posDoc.size
            : (posDoc.entryPrice - posDoc.stopLoss) * posDoc.size
        });

        results.push({ positionId: posDoc.$id, action: 'detected_closed', reason: 'stop_loss' });
        continue;
      }

      // 2. 计算未实现盈亏
      const unrealizedPnL = posDoc.side === 'LONG'
        ? (currentPrice - posDoc.entryPrice) * posDoc.size
        : (posDoc.entryPrice - currentPrice) * posDoc.size;

      const unrealizedPnLPercent = (unrealizedPnL / posDoc.margin) * 100;

      log(`   Unrealized PnL: $${unrealizedPnL.toFixed(2)} (${unrealizedPnLPercent.toFixed(1)}%)`);

      // 3. 检查 HTF 目标
      const htfOBs = await appwrite.getActiveOBs(symbol);
      
      for (const htfOB of htfOBs.documents || []) {
        if (!CONFIG.STRATEGY.TIMEFRAMES.HTF_TARGETS.includes(htfOB.timeframe)) continue;

        const isTarget =
          (posDoc.side === 'LONG' && htfOB.type === 'BEARISH' && currentPrice >= htfOB.bottom) ||
          (posDoc.side === 'SHORT' && htfOB.type === 'BULLISH' && currentPrice <= htfOB.top);

        if (isTarget) {
          log(`🎯 HTF target reached`);

          const closeResult = await hl.closePosition({
            symbol,
            size: posDoc.size,
            price: currentPrice
          });

          if (closeResult.success) {
            await appwrite.updatePosition(posDoc.$id, {
              status: 'CLOSED',
              exitTime: new Date().toISOString(),
              exitReason: `HTF_TARGET_${htfOB.timeframe}`,
              exitPrice: closeResult.executionPrice,
              pnl: unrealizedPnL
            });

            results.push({ positionId: posDoc.$id, action: 'closed', reason: 'htf_target', pnl: unrealizedPnL });
            break;
          }
        }
      }

      // 4. 追踪止损
      if (unrealizedPnLPercent > CONFIG.STRATEGY.TRAILING_STOP_TRIGGER_PERCENT) {
        const atrData = await appwrite.getMarketData(symbol, 'ATR', CONFIG.STRATEGY.TIMEFRAMES.ENTRY);
        const atr = atrData ? atrData.value : 1000;

        const newStopLoss = posDoc.side === 'LONG'
          ? currentPrice - (atr * CONFIG.STRATEGY.TRAILING_STOP_ATR_MULTIPLIER)
          : currentPrice + (atr * CONFIG.STRATEGY.TRAILING_STOP_ATR_MULTIPLIER);

        const shouldUpdate = posDoc.side === 'LONG'
          ? newStopLoss > posDoc.stopLoss
          : newStopLoss < posDoc.stopLoss;

        if (shouldUpdate) {
          log(`📈 Updating trailing stop: ${posDoc.stopLoss.toFixed(0)} → ${newStopLoss.toFixed(0)}`);

          const updateResult = await hl.updateStopLoss({
            symbol,
            stopLossOrderId: posDoc.stopLossOrderId,
            newStopLoss
          });

          if (updateResult.success) {
            await appwrite.updatePosition(posDoc.$id, {
              stopLoss: newStopLoss,
              stopLossOrderId: updateResult.newStopLossOrderId,
              lastStopUpdate: new Date().toISOString()
            });

            results.push({ positionId: posDoc.$id, action: 'trailing_stop_updated', newStopLoss });
          }
        }
      }

      // 5. 更新状态
      await appwrite.updatePosition(posDoc.$id, {
        lastChecked: new Date().toISOString(),
        lastPrice: currentPrice,
        unrealizedPnL
      });

      results.push({
        positionId: posDoc.$id,
        action: 'monitored',
        unrealizedPnL,
        unrealizedPnLPercent
      });
    }

    return res.json({
      success: true,
      positionsChecked: openPositions.documents.length,
      currentPrice,
      results,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`Position monitor error: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};