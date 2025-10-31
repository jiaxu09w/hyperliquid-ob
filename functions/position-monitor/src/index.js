/**
 * Position Monitor - 监控持仓状态
 * - 检查止损触发
 * - HTF 目标检测
 * - 反向 OB 检测
 * - 追踪止损更新
 * - 强平风险预警
 */

const { Client, Databases, Query, ID } = require('node-appwrite');
const HyperliquidAPI = require('./hyperliquid');
const { COLLECTIONS, SIDE, OB_TYPE, EXIT_REASON } = require('./constants');

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log('👀 Position Monitor started');

    // ✅ 配置
    const config = {
      // Appwrite
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,
      
      // Trading
      symbol: process.env.TRADING_SYMBOL || 'BTCUSDT',
      tradingEnabled: process.env.TRADING_ENABLED === 'true',
      
      // Strategy
      trailingStopTriggerPercent: 5,  // 盈利5%后启动追踪止损
      trailingStopMultiplier: parseFloat(process.env.TRAILING_STOP_ATR_MULTIPLIER) || 2.5,
      liquidationWarningPercent: 5,   // 距离强平价5%时预警
    };

    // ✅ 初始化 Appwrite
    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    // ✅ 1. 获取所有未平仓位
    log(`Checking open positions for ${config.symbol}...`);
    
    const openPositions = await databases.listDocuments(
      config.databaseId,
      COLLECTIONS.POSITIONS,
      [
        Query.equal('symbol', config.symbol),
        Query.equal('status', 'OPEN'),
        Query.limit(10)
      ]
    );

    if (openPositions.documents.length === 0) {
      log('No open positions found');
      return res.json({ 
        success: true, 
        action: 'no_positions',
        message: 'No positions to monitor'
      });
    }

    log(`Found ${openPositions.documents.length} open position(s)`);

    // ✅ 2. 初始化 Hyperliquid
    const hl = new HyperliquidAPI(
      process.env.HYPERLIQUID_PRIVATE_KEY,
      !config.tradingEnabled
    );

    const currentPrice = await hl.getPrice(config.symbol);
    log(`Current price: $${currentPrice.toFixed(2)}\n`);

    const results = [];

    // ✅ 3. 逐个检查持仓
    for (const posDoc of openPositions.documents) {
      log(`\n--- Position ${posDoc.$id.substring(0, 8)} ---`);
      log(`Side: ${posDoc.side} | Entry: $${posDoc.avgEntryPrice.toFixed(2)} | Size: ${posDoc.size.toFixed(4)}`);

      // ✅ 3.1 验证持仓是否仍存在（可能已被止损）
      const livePosition = await hl.getPosition(config.symbol.replace('USDT', ''));
      
      if (!livePosition || (livePosition.szi !== undefined && Math.abs(livePosition.szi) === 0)) {
        log('⚠️  Position not found on exchange (likely stopped out)');
        
        // 标记为已平仓
        await databases.updateDocument(
          config.databaseId,
          COLLECTIONS.POSITIONS,
          posDoc.$id,
          {
            status: 'CLOSED',
            exitTime: new Date().toISOString(),
            exitReason: EXIT_REASON.STOP_LOSS_TRIGGERED,
            exitPrice: posDoc.stopLoss,
            pnl: posDoc.side === SIDE.LONG
              ? (posDoc.stopLoss - posDoc.avgEntryPrice) * posDoc.size
              : (posDoc.avgEntryPrice - posDoc.stopLoss) * posDoc.size
          }
        );

        results.push({
          positionId: posDoc.$id,
          action: 'detected_closed',
          reason: EXIT_REASON.STOP_LOSS_TRIGGERED
        });
        
        log('✅ Marked as closed in database');
        continue;
      }

      // ✅ 3.2 计算未实现盈亏
      const unrealizedPnL = posDoc.side === SIDE.LONG
        ? (currentPrice - posDoc.avgEntryPrice) * posDoc.size
        : (posDoc.avgEntryPrice - currentPrice) * posDoc.size;

      const positionValue = posDoc.avgEntryPrice * posDoc.size;
      const unrealizedPnLPercent = (unrealizedPnL / positionValue) * 100;

      log(`Unrealized PnL: $${unrealizedPnL.toFixed(2)} (${unrealizedPnLPercent.toFixed(2)}%)`);

      // ✅ 3.3 检查 HTF 目标
      log('Checking HTF targets...');
      
      const htfTimeframes = (process.env.HTF_TARGETS || '1w,1d').split(',');
      let hitTarget = false;

      for (const htfTf of htfTimeframes) {
        const htfOBs = await databases.listDocuments(
          config.databaseId,
          COLLECTIONS.ORDER_BLOCKS,
          [
            Query.equal('symbol', config.symbol),
            Query.equal('timeframe', htfTf.trim()),
            Query.equal('isActive', true),
            Query.limit(10)
          ]
        );

        for (const htfOB of htfOBs.documents) {
          // 检查是否是反向 OB 且价格已触及
          const isTarget = 
            (posDoc.side === SIDE.LONG && 
             htfOB.type === OB_TYPE.BEARISH && 
             currentPrice >= htfOB.bottom) ||
            (posDoc.side === SIDE.SHORT && 
             htfOB.type === OB_TYPE.BULLISH && 
             currentPrice <= htfOB.top);

          if (isTarget) {
            const targetPrice = posDoc.side === SIDE.LONG ? htfOB.bottom : htfOB.top;
            log(`🎯 HTF ${htfTf} target reached @ $${targetPrice.toFixed(2)}`);

            // 平仓
            const closeResult = await hl.closePosition({
              symbol: config.symbol,
              size: posDoc.size,
              price: currentPrice
            });

            if (closeResult.success) {
              await databases.updateDocument(
                config.databaseId,
                COLLECTIONS.POSITIONS,
                posDoc.$id,
                {
                  status: 'CLOSED',
                  exitTime: new Date().toISOString(),
                  exitReason: `HTF_TARGET_${htfTf}`,
                  exitPrice: closeResult.executionPrice || currentPrice,
                  pnl: unrealizedPnL,
                  exitFee: closeResult.fee || 0
                }
              );

              results.push({
                positionId: posDoc.$id,
                action: 'closed',
                reason: `HTF_TARGET_${htfTf}`,
                pnl: unrealizedPnL
              });

              log('✅ Position closed at HTF target');
              hitTarget = true;
              break;
            }
          }
        }
        
        if (hitTarget) break;
      }

      if (hitTarget) continue;

      // ✅ 3.4 检查反向 OB
      log('Checking for reversal OBs...');
      
      const entryTfOBs = await databases.listDocuments(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        [
          Query.equal('symbol', config.symbol),
          Query.equal('timeframe', process.env.ENTRY_TIMEFRAME || '4h'),
          Query.equal('isActive', true),
          Query.orderDesc('confirmationTime'),
          Query.limit(5)
        ]
      );

      let foundReversal = false;
      for (const ob of entryTfOBs.documents) {
        const isReversal = 
          (posDoc.side === SIDE.LONG && ob.type === OB_TYPE.BEARISH) ||
          (posDoc.side === SIDE.SHORT && ob.type === OB_TYPE.BULLISH);

        if (isReversal) {
          const obAge = (Date.now() - new Date(ob.confirmationTime)) / (1000 * 60 * 60);
          
          if (obAge <= 6) {  // 6 小时内形成
            log(`🔄 Reversal OB detected (${obAge.toFixed(1)}h old)`);

            const closeResult = await hl.closePosition({
              symbol: config.symbol,
              size: posDoc.size,
              price: currentPrice
            });

            if (closeResult.success) {
              await databases.updateDocument(
                config.databaseId,
                COLLECTIONS.POSITIONS,
                posDoc.$id,
                {
                  status: 'CLOSED',
                  exitTime: new Date().toISOString(),
                  exitReason: EXIT_REASON.REVERSAL_OB,
                  exitPrice: closeResult.executionPrice || currentPrice,
                  pnl: unrealizedPnL,
                  exitFee: closeResult.fee || 0
                }
              );

              results.push({
                positionId: posDoc.$id,
                action: 'closed',
                reason: EXIT_REASON.REVERSAL_OB,
                pnl: unrealizedPnL
              });

              log('✅ Position closed on reversal OB');
              foundReversal = true;
              break;
            }
          }
        }
      }

      if (foundReversal) continue;

      // ✅ 3.5 追踪止损更新
      if (unrealizedPnLPercent > config.trailingStopTriggerPercent) {
        log(`Checking trailing stop (profit: ${unrealizedPnLPercent.toFixed(2)}%)...`);

        // 获取 ATR
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

        if (atrData.documents.length > 0) {
          const atr = atrData.documents[0].value;
          
          const newStopLoss = posDoc.side === SIDE.LONG
            ? currentPrice - (atr * config.trailingStopMultiplier)
            : currentPrice + (atr * config.trailingStopMultiplier);

          const shouldUpdate = posDoc.side === SIDE.LONG
            ? newStopLoss > posDoc.stopLoss
            : newStopLoss < posDoc.stopLoss;

          if (shouldUpdate) {
            log(`📈 Updating trailing stop: $${posDoc.stopLoss.toFixed(2)} → $${newStopLoss.toFixed(2)}`);

            // 更新交易所的止损单
            const updateResult = await hl.updateStopLoss({
              symbol: config.symbol,
              stopLossOrderId: posDoc.stopLossOrderId,
              newStopLoss
            });

            if (updateResult.success) {
              await databases.updateDocument(
                config.databaseId,
                COLLECTIONS.POSITIONS,
                posDoc.$id,
                {
                  stopLoss: newStopLoss,
                  stopLossOrderId: updateResult.newStopLossOrderId,
                  lastStopUpdate: new Date().toISOString()
                }
              );

              results.push({
                positionId: posDoc.$id,
                action: 'trailing_stop_updated',
                newStopLoss
              });

              log('✅ Trailing stop updated');
            } else {
              log('⚠️  Failed to update trailing stop');
            }
          }
        }
      }

      // ✅ 3.6 检查强平风险
      if (posDoc.liquidationPrice) {
        const distanceToLiq = posDoc.side === SIDE.LONG
          ? ((currentPrice - posDoc.liquidationPrice) / posDoc.liquidationPrice) * 100
          : ((posDoc.liquidationPrice - currentPrice) / posDoc.liquidationPrice) * 100;

        if (distanceToLiq < config.liquidationWarningPercent) {
          log(`⚡ WARNING: Near liquidation! Distance: ${distanceToLiq.toFixed(2)}%`);

          // 紧急平仓（可选）
          if (distanceToLiq < 2) {
            log('🚨 Emergency close initiated!');
            
            const closeResult = await hl.closePosition({
              symbol: config.symbol,
              size: posDoc.size,
              price: currentPrice
            });

            if (closeResult.success) {
              await databases.updateDocument(
                config.databaseId,
                COLLECTIONS.POSITIONS,
                posDoc.$id,
                {
                  status: 'CLOSED',
                  exitTime: new Date().toISOString(),
                  exitReason: EXIT_REASON.EMERGENCY_CLOSE,
                  exitPrice: closeResult.executionPrice || currentPrice,
                  pnl: unrealizedPnL,
                  exitFee: closeResult.fee || 0
                }
              );

              results.push({
                positionId: posDoc.$id,
                action: 'emergency_close',
                reason: 'near_liquidation',
                pnl: unrealizedPnL
              });

              log('✅ Emergency close executed');
              continue;
            }
          }
        }
      }

      // ✅ 3.7 更新持仓状态
      await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.POSITIONS,
        posDoc.$id,
        {
          lastChecked: new Date().toISOString(),
          lastPrice: currentPrice,
          unrealizedPnL
        }
      );

      results.push({
        positionId: posDoc.$id,
        action: 'monitored',
        unrealizedPnL,
        unrealizedPnLPercent: unrealizedPnLPercent.toFixed(2)
      });

      log('✅ Status updated');
    }

    const duration = Date.now() - startTime;
    log(`\n✅ Position Monitor completed in ${duration}ms`);

    return res.json({
      success: true,
      positionsChecked: openPositions.documents.length,
      currentPrice,
      results,
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`Position monitor error: ${err.message}`);
    error(err.stack);
    
    return res.json({ 
      success: false, 
      error: err.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
};