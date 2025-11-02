/**
 * Entry Monitor v3.2 - 真正的突破入场策略
 *
 * 新功能：
 * ✅ OB 过期机制（60分钟）
 * ✅ 改进的加仓逻辑
 * ✅ 交易日志记录
 * ✅ 准确的术语（priceDeviation 非 slippage）
 */

const { Client, Databases, Query, ID } = require("node-appwrite");
const nodemailer = require("nodemailer");
const HyperliquidAPI = require("./hyperliquid");
const { COLLECTIONS, MARKETS, SIDE, OB_TYPE } = require("./constants");
const { checkAccountProtection, triggerCooldown } = require('./account-protection');
const { logTradeEvent } = require('./trade-logger');

// ═════════════════════════════════════════════════════════════════════════
// 工具函数
// ═════════════════════════════════════════════════════════════════════════

async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000, fnName = "Operation") {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;

      const delay = initialDelay * Math.pow(2, i);
      console.log(`⚠️  ${fnName} failed (attempt ${i + 1}/${maxRetries}), retrying in ${delay}ms...`);
      console.log(`   Error: ${err.message}`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function validateConfig(config) {
  const errors = [];

  if (!config.endpoint) errors.push('Missing APPWRITE_ENDPOINT');
  if (!config.projectId) errors.push('Missing APPWRITE_PROJECT_ID');
  if (!config.apiKey) errors.push('Missing APPWRITE_API_KEY');
  if (!config.databaseId) errors.push('Missing APPWRITE_DATABASE_ID');
  
  if (config.leverage < 1 || config.leverage > 10) {
    errors.push('LEVERAGE must be between 1-10');
  }
  
  if (config.riskPercent < 0.1 || config.riskPercent > 5) {
    errors.push('RISK_PER_TRADE must be between 0.1-5%');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join('\n')}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 主函数
// ═════════════════════════════════════════════════════════════════════════

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log("━".repeat(60));
    log("📊 Entry Monitor v3.2 - Breakout Entry");
    log("━".repeat(60));

    const config = {
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,

      symbol: process.env.TRADING_SYMBOL || "BTCUSDT",
      tradingEnabled: process.env.TRADING_ENABLED === "true",
      leverage: parseInt(process.env.LEVERAGE) || 2,
      riskPercent: parseFloat(process.env.RISK_PER_TRADE) || 1.0,

      maxAdditions: parseInt(process.env.MAX_ADDITIONS) || 1,
      scaleDownFactor: parseFloat(process.env.SCALE_DOWN_FACTOR) || 0.5,
      minProfitForAddition: parseFloat(process.env.MIN_PROFIT_FOR_ADDITION) || 1.5,

      requireHighConfidence: process.env.REQUIRE_HIGH_CONFIDENCE === "true",
      
      maxDeviationForMarket: parseFloat(process.env.MAX_DEVIATION_MARKET) || 0.8,
      maxDeviationForLimit: parseFloat(process.env.MAX_DEVIATION_LIMIT) || 2.0,
      limitOrderWaitTime: parseInt(process.env.LIMIT_ORDER_WAIT_TIME) || 240,
      limitPriceAdjustment: parseFloat(process.env.LIMIT_PRICE_ADJUSTMENT) || 0.2,
      
      maxOBAgeMinutes: parseInt(process.env.MAX_OB_AGE_MINUTES) || 60,

      apiTimeout: parseInt(process.env.API_TIMEOUT) || 10000,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,

      emailEnabled: process.env.EMAIL_ENABLED === "true",
      emailRecipient: process.env.EMAIL_RECIPIENT,
      emailConfig: {
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_APP_PASSWORD,
        },
      },
    };

    validateConfig(config);

    log(`\n⚙️  Configuration:`);
    log(`   Symbol: ${config.symbol}`);
    log(`   Mode: ${config.tradingEnabled ? "🔴 LIVE" : "🧪 TESTNET"}`);
    log(`   Risk: ${config.riskPercent}% | Leverage: ${config.leverage}x`);
    log(`   Max OB age: ${config.maxOBAgeMinutes} minutes`);
    log(`   Strategy: Breakout + Volume (5-min cycle)`);
    log(`   └─ Market if deviation < ${config.maxDeviationForMarket}%`);
    log(`   └─ Limit if deviation < ${config.maxDeviationForLimit}%`);

    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    const hl = new HyperliquidAPI(
      process.env.HYPERLIQUID_PRIVATE_KEY,
      !config.tradingEnabled
    );

    // 1️⃣ 检查持仓
    log(`\n1️⃣  Checking positions...`);

    const openPositions = await retryWithBackoff(
      () => databases.listDocuments(config.databaseId, COLLECTIONS.POSITIONS, [
        Query.equal("symbol", config.symbol),
        Query.equal("status", "OPEN"),
        Query.limit(1),
      ]),
      3, 1000, "List positions"
    );

    const hasPosition = openPositions.documents.length > 0;
    const existingPosition = hasPosition ? openPositions.documents[0] : null;

    if (hasPosition) {
      log(`   ✅ ${existingPosition.side} position | Avg: $${existingPosition.avgEntryPrice.toFixed(2)} | Additions: ${existingPosition.additionCount}/${config.maxAdditions}`);
    } else {
      log(`   No positions`);
    }

    // 2️⃣ 查找 OB
    log(`\n2️⃣  Searching for OBs...`);

    const unprocessedOBs = await retryWithBackoff(
      () => databases.listDocuments(config.databaseId, COLLECTIONS.ORDER_BLOCKS, [
        Query.equal("symbol", config.symbol),
        Query.equal("isActive", true),
        Query.equal("isProcessed", false),
        Query.orderDesc("confirmationTime"),
        Query.limit(5),
      ]),
      3, 1000, "List OBs"
    );

    if (unprocessedOBs.documents.length === 0) {
      log(`   No new OBs`);
      return res.json({ success: true, action: "no_signal", hasPosition });
    }

    log(`   Found ${unprocessedOBs.documents.length} unprocessed OB(s)`);

    // 3️⃣ 获取市场数据
    log(`\n3️⃣  Market data...`);

    const currentPrice = await retryWithBackoff(() => hl.getPrice(config.symbol), 3, 2000, "Get price");
    const balance = await retryWithBackoff(() => hl.getBalance(), 3, 2000, "Get balance");

    log(`   Price: $${currentPrice.toFixed(2)} | Balance: $${balance.toFixed(2)}`);

    if (balance < 10) {
      error(`   ❌ Insufficient balance`);
      return res.json({ success: false, error: "Insufficient balance", balance }, 400);
    }

    // 3.5️⃣ 账户保护
    log(`\n3️⃣.5 Account protection...`);

    const protectionResult = await checkAccountProtection(databases, config.databaseId, hl, log);

    if (!protectionResult.allowed) {
      error(`\n🛑 Blocked: ${protectionResult.reason}`);

      if (['consecutive_losses', 'max_drawdown', 'daily_loss_limit'].includes(protectionResult.reason)) {
        await triggerCooldown(databases, config.databaseId, protectionResult.reason, log);
      }

      return res.json({
        success: false,
        action: 'blocked_by_protection',
        protection: protectionResult
      }, 403);
    }

    log(`   ✅ Protection passed`);

    // 4️⃣ 评估 OB
    log(`\n4️⃣  Evaluating OBs...`);

    const marketConfig = MARKETS[config.symbol] || MARKETS.BTCUSDT;
    let selectedOB = null;
    let action = null;

    for (const ob of unprocessedOBs.documents) {
      log(`\n   ├─ OB ${ob.$id.substring(0, 8)}`);
      log(`   │  ${ob.type} | $${ob.bottom.toFixed(2)}-$${ob.top.toFixed(2)} | ${ob.confidence}`);

      // ✅ OB 年龄检查
      const obAgeMinutes = (Date.now() - new Date(ob.confirmationTime)) / (1000 * 60);
      log(`   │  Age: ${obAgeMinutes.toFixed(1)} min`);

      if (obAgeMinutes > config.maxOBAgeMinutes) {
        log(`   │  ⏰ EXPIRED (>${config.maxOBAgeMinutes}min)`);
        
        await databases.updateDocument(
          config.databaseId,
          COLLECTIONS.ORDER_BLOCKS,
          ob.$id,
          {
            isProcessed: true,
            processedAt: new Date().toISOString(),
            processedReason: 'expired_max_age',
            processedPrice: currentPrice
          }
        );
        
        continue;
      }

      if (config.requireHighConfidence && ob.confidence !== "high") {
        log(`   │  ❌ Low confidence`);
        continue;
      }

      if (hasPosition) {
        // 加仓检查
        const isSameDirection =
          (existingPosition.side === SIDE.LONG && ob.type === OB_TYPE.BULLISH) ||
          (existingPosition.side === SIDE.SHORT && ob.type === OB_TYPE.BEARISH);

        if (!isSameDirection) {
          log(`   │  ⚠️  Wrong direction`);
          continue;
        }

        if (existingPosition.additionCount >= config.maxAdditions) {
          log(`   │  ⚠️  Max additions reached`);
          continue;
        }

        const unrealizedPnL = existingPosition.side === SIDE.LONG
          ? (currentPrice - existingPosition.avgEntryPrice) * existingPosition.size
          : (existingPosition.avgEntryPrice - currentPrice) * existingPosition.size;

        const unrealizedPnLPercent = (unrealizedPnL / balance) * 100;
        log(`   │  P&L: ${unrealizedPnLPercent >= 0 ? '+' : ''}${unrealizedPnLPercent.toFixed(2)}%`);

        if (unrealizedPnLPercent < config.minProfitForAddition) {
          log(`   │  ⚠️  Need ${config.minProfitForAddition}% profit`);
          continue;
        }

        // ✅ 改进的加仓逻辑
        const lastOBBottom = existingPosition.lastOBBottom || 0;
        const lastOBTop = existingPosition.lastOBTop || Infinity;

        const obDistance = existingPosition.side === SIDE.LONG
          ? Math.abs(ob.bottom - lastOBBottom) / lastOBBottom
          : Math.abs(ob.top - lastOBTop) / lastOBTop;

        const significantlyBetter = 
          (existingPosition.side === SIDE.LONG && ob.bottom > lastOBBottom * 1.02) ||
          (existingPosition.side === SIDE.SHORT && ob.top < lastOBTop * 0.98);

        const withinRangeAndConfident = obDistance < 0.05 && ob.confidence === 'high';

        if (!significantlyBetter && !withinRangeAndConfident) {
          log(`   │  ⚠️  Not suitable (distance: ${(obDistance * 100).toFixed(2)}%)`);
          continue;
        }

        log(`   │  ✅ Valid for ADDITION`);
        selectedOB = ob;
        action = "ADD";
        break;

      } else {
        log(`   │  ✅ Valid for NEW POSITION`);
        selectedOB = ob;
        action = "OPEN";
        break;
      }
    }

    if (!selectedOB) {
      log(`\n   No valid OB`);
      return res.json({ success: true, action: "no_valid_ob", hasPosition });
    }

    log(`\n   ✅ Selected: ${action}`);

    // 5️⃣ 计算仓位
    log(`\n5️⃣  Position calculation...`);

    const side = selectedOB.type === OB_TYPE.BULLISH ? SIDE.LONG : SIDE.SHORT;
    const stopLoss = side === SIDE.LONG ? selectedOB.bottom : selectedOB.top;

    log(`   ${side} | SL: $${stopLoss.toFixed(2)}`);

    let riskAmount, positionSize;

    if (action === "OPEN") {
      riskAmount = balance * (config.riskPercent / 100);
      const riskDistance = Math.abs(currentPrice - stopLoss);
      positionSize = riskAmount / riskDistance;
    } else {
      const additionNumber = existingPosition.additionCount + 1;
      const scaleFactor = Math.pow(config.scaleDownFactor, additionNumber);
      riskAmount = balance * (config.riskPercent / 100) * scaleFactor;
      const riskDistance = Math.abs(currentPrice - stopLoss);
      positionSize = riskAmount / riskDistance;
      log(`   Addition #${additionNumber} | Scale: ${scaleFactor.toFixed(2)}x`);
    }

    positionSize = Math.floor(positionSize / marketConfig.sizeIncrement) * marketConfig.sizeIncrement;
    log(`   Size: ${positionSize.toFixed(4)} | Risk: $${riskAmount.toFixed(2)}`);

    if (positionSize < marketConfig.minSize) {
      log(`   ❌ Too small`);
      
      await databases.updateDocument(config.databaseId, COLLECTIONS.ORDER_BLOCKS, selectedOB.$id, {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason: 'size_too_small',
        processedPrice: currentPrice
      });
      
      return res.json({ success: true, action: "size_too_small", calculatedSize: positionSize });
    }

    const positionValue = positionSize * currentPrice;
    const requiredMargin = positionValue / config.leverage;

    if (requiredMargin > balance * 0.95) {
      error("   ❌ Insufficient margin");
      return res.json({ success: false, error: "Insufficient margin" }, 400);
    }

    // 6️⃣ 入场策略
    log(`\n6️⃣  Entry strategy...`);

    const breakoutPrice = getBreakoutPrice(selectedOB);
    const priceDeviation = Math.abs(currentPrice - breakoutPrice) / breakoutPrice;
    const deviationPercent = priceDeviation * 100;

    log(`   Breakout: $${breakoutPrice.toFixed(2)}`);
    log(`   Current: $${currentPrice.toFixed(2)}`);
    log(`   Deviation: ${deviationPercent.toFixed(2)}%`);

    let orderResult, orderStrategy, pendingDoc = null;

    if (deviationPercent <= config.maxDeviationForMarket) {
      // 市价单
      log(`\n   ✅ Small deviation → Market order`);
      orderStrategy = "market";

      if (action === "OPEN") {
        pendingDoc = await databases.createDocument(config.databaseId, COLLECTIONS.POSITIONS, ID.unique(), {
          symbol: config.symbol, side, status: "PENDING",
          entryPrice: currentPrice, avgEntryPrice: currentPrice,
          size: positionSize, stopLoss,
          leverage: config.leverage, margin: requiredMargin,
          plannedRisk: riskAmount,
          openTime: new Date().toISOString(),
          relatedOB: selectedOB.$id,
          obConfidence: selectedOB.confidence,
          obType: selectedOB.type,
          obBottom: selectedOB.bottom, obTop: selectedOB.top,
          lastOBBottom: selectedOB.bottom, lastOBTop: selectedOB.top,
          breakoutPrice,
          strategyType: "ob_breakout",
          strategyVersion: "v3.2_breakout",
          additionCount: 0,
          orderStrategy: "market"
        });
      }

      orderResult = await retryWithBackoff(
        () => hl.placeOrderWithStopLoss({
          symbol: config.symbol, side, size: positionSize,
          entryPrice: currentPrice, stopLoss, orderType: "market"
        }),
        config.maxRetries, 2000, "Market order"
      );

      if (!orderResult.success && pendingDoc) {
        await databases.updateDocument(config.databaseId, COLLECTIONS.POSITIONS, pendingDoc.$id,
          { status: "FAILED", failureReason: orderResult.error });
      }

    } else if (deviationPercent <= config.maxDeviationForLimit) {
      // 限价单
      log(`\n   📋 Moderate deviation → Limit order`);
      orderStrategy = "limit";

      let limitPrice = side === SIDE.LONG
        ? currentPrice * (1 - config.limitPriceAdjustment / 100)
        : currentPrice * (1 + config.limitPriceAdjustment / 100);

      // 确保不会超出OB范围
      if (side === SIDE.LONG && limitPrice < selectedOB.bottom) {
        limitPrice = selectedOB.bottom * 1.001;
      } else if (side === SIDE.SHORT && limitPrice > selectedOB.top) {
        limitPrice = selectedOB.top * 0.999;
      }

      limitPrice = parseFloat(limitPrice.toFixed(marketConfig.pricePrecision));

      log(`   Limit: $${limitPrice.toFixed(2)}`);

      if (action === "OPEN") {
        pendingDoc = await databases.createDocument(config.databaseId, COLLECTIONS.POSITIONS, ID.unique(), {
          symbol: config.symbol, side, status: "PENDING",
          entryPrice: limitPrice, avgEntryPrice: limitPrice,
          size: positionSize, stopLoss,
          leverage: config.leverage, margin: requiredMargin,
          plannedRisk: riskAmount,
          openTime: new Date().toISOString(),
          relatedOB: selectedOB.$id,
          obConfidence: selectedOB.confidence,
          obType: selectedOB.type,
          obBottom: selectedOB.bottom, obTop: selectedOB.top,
          lastOBBottom: selectedOB.bottom, lastOBTop: selectedOB.top,
          breakoutPrice,
          strategyType: "ob_breakout",
          strategyVersion: "v3.2_breakout",
          additionCount: 0,
          orderStrategy: "limit",
          limitPrice
        });
      }

      orderResult = await retryWithBackoff(
        () => hl.placeOrderWithStopLoss({
          symbol: config.symbol, side, size: positionSize,
          entryPrice: limitPrice, stopLoss, orderType: "limit"
        }),
        config.maxRetries, 2000, "Limit order"
      );

      if (orderResult.success && orderResult.orderStatus === "resting") {
        log(`   📋 Order resting, waiting ${config.limitOrderWaitTime}s...`);

        const fillResult = await waitForOrderFill(hl, orderResult.orderId, config.limitOrderWaitTime, log);

        if (fillResult.filled) {
          log(`   ✅ Filled @ $${fillResult.executionPrice.toFixed(2)}`);
          orderResult.executionPrice = fillResult.executionPrice;
          orderResult.executedSize = fillResult.executedSize;
          orderResult.fee = fillResult.fee;
          orderResult.orderStatus = "filled";
        } else {
          log(`   ⏭️  Not filled (${fillResult.reason})`);
          await hl.cancelOrder(orderResult.orderId);

          if (pendingDoc) {
            await databases.updateDocument(config.databaseId, COLLECTIONS.POSITIONS, pendingDoc.$id, {
              status: "CANCELLED",
              cancelReason: `limit_not_filled_${fillResult.reason}`
            });
          }

          return res.json({
            success: true,
            action: "limit_not_filled",
            reason: fillResult.reason,
            canRetry: true
          });
        }
      }

    } else {
      log(`\n   ⏭️  Large deviation (${deviationPercent.toFixed(2)}%)`);
      log(`   Skipping (OB may be invalid)`);

      return res.json({
        success: true,
        action: "skipped_large_deviation",
        deviation: deviationPercent.toFixed(2) + "%",
        canRetry: true
      });
    }

    // 验证订单
    if (!orderResult?.success || orderResult.orderStatus !== "filled") {
      error(`   ❌ Order failed`);
      return res.json({ success: false, error: orderResult?.error }, 500);
    }

    log(`   ✅ Executed: $${orderResult.executionPrice.toFixed(2)} | ${orderResult.executedSize.toFixed(4)}`);

    // 7️⃣ 更新数据库
    log(`\n7️⃣  Updating database...`);

    const actualRisk = Math.abs(orderResult.executionPrice - stopLoss) * orderResult.executedSize;
    const actualRiskPercent = (actualRisk / balance) * 100;

    let finalPosition;

    try {
      if (action === "OPEN") {
        finalPosition = await databases.updateDocument(config.databaseId, COLLECTIONS.POSITIONS, pendingDoc.$id, {
          status: "OPEN",
          entryPrice: orderResult.executionPrice,
          avgEntryPrice: orderResult.executionPrice,
          size: orderResult.executedSize,
          stopLossOrderId: orderResult.stopLossOrderId,
          liquidationPrice: orderResult.liquidationPrice || 0,
          actualRisk, actualRiskPercent,
          entryFee: orderResult.fee,
          orderStrategy,
          executedAt: new Date().toISOString()
        });
      } else {
        const totalCost = existingPosition.avgEntryPrice * existingPosition.size + orderResult.executionPrice * orderResult.executedSize;
        const totalSize = existingPosition.size + orderResult.executedSize;
        const newAvgPrice = totalCost / totalSize;

        finalPosition = await databases.updateDocument(config.databaseId, COLLECTIONS.POSITIONS, existingPosition.$id, {
          size: totalSize,
          avgEntryPrice: newAvgPrice,
          stopLoss,
          additionCount: existingPosition.additionCount + 1,
          lastOBBottom: selectedOB.bottom,
          lastOBTop: selectedOB.top,
          lastAdditionTime: new Date().toISOString(),
          entryFee: existingPosition.entryFee + orderResult.fee,
          [`addition${existingPosition.additionCount + 1}Price`]: orderResult.executionPrice,
          [`addition${existingPosition.additionCount + 1}Size`]: orderResult.executedSize,
          [`addition${existingPosition.additionCount + 1}Time`]: new Date().toISOString()
        });

        log(`   New avg: $${newAvgPrice.toFixed(2)}`);
      }

      await databases.updateDocument(config.databaseId, COLLECTIONS.ORDER_BLOCKS, selectedOB.$id, {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason: action === "OPEN" ? "position_opened" : "position_added",
        processedPrice: orderResult.executionPrice
      });

      // ✅ 记录交易事件
      await logTradeEvent(databases, config.databaseId, {
        eventType: action === "OPEN" ? "OPEN" : "ADD",
        symbol: config.symbol, side,
        price: orderResult.executionPrice,
        size: orderResult.executedSize,
        fee: orderResult.fee,
        positionId: finalPosition.$id,
        avgEntryPrice: finalPosition.avgEntryPrice,
        totalSize: finalPosition.size,
        obId: selectedOB.$id,
        obType: selectedOB.type,
        obConfidence: selectedOB.confidence,
        orderStrategy,
        balance, leverage: config.leverage,
        stopLoss, liquidationPrice: orderResult.liquidationPrice,
        deviation: deviationPercent,
        obAge: obAgeMinutes.toFixed(1)
      });

      log(`   ✅ Database updated & logged`);

    } catch (dbErr) {
      error(`   ❌ DB error: ${dbErr.message}`);
      
      if (config.emailEnabled) {
        await sendEmergencyAlert({ config, error: dbErr.message, orderResult, selectedOB });
      }
      
      return res.json({
        success: false,
        error: dbErr.message,
        orderExecuted: true,
        orderId: orderResult.orderId
      }, 500);
    }

    // 8️⃣ 邮件通知
    if (config.emailEnabled) {
      try {
        await sendEmailNotification({
          config, action, position: finalPosition, orderResult, selectedOB,
          breakoutPrice, currentPrice, deviationPercent, orderStrategy, balance
        });
        log(`   ✅ Email sent`);
      } catch (emailErr) {
        error(`   ⚠️  Email failed: ${emailErr.message}`);
      }
    }

    const duration = Date.now() - startTime;

    log(`\n${"━".repeat(60)}`);
    log(`✅ Completed in ${duration}ms`);
    log(`${"━".repeat(60)}\n`);

    return res.json({
      success: true,
      action: action === "OPEN" ? "position_opened" : "position_added",
      position: {
        id: finalPosition.$id,
        symbol: config.symbol,
        side,
        entryPrice: orderResult.executionPrice,
        size: finalPosition.size,
        stopLoss,
        risk: actualRiskPercent.toFixed(2) + "%"
      },
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`\n❌ Error: ${err.message}`);
    error(err.stack);

    return res.json({ success: false, error: err.message }, 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════
// 辅助函数
// ═════════════════════════════════════════════════════════════════════════

function getBreakoutPrice(ob) {
  if (ob.breakoutPrice && ob.breakoutPrice > 0) return ob.breakoutPrice;
  if (ob.confirmationCandleClose && ob.confirmationCandleClose > 0) return ob.confirmationCandleClose;
  return ob.type === OB_TYPE.BULLISH ? ob.top : ob.bottom;
}

async function waitForOrderFill(hl, orderId, timeoutSeconds, log) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  let lastLog = 0;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await hl.getOrderStatus(orderId);

      if (status.status === "filled") {
        return {
          filled: true,
          executionPrice: status.avgPrice,
          executedSize: status.filledSize,
          fee: status.fee
        };
      }

      if (status.status === "cancelled" || status.status === "rejected") {
        return { filled: false, reason: status.status };
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed - lastLog >= 10) {
        log(`   ⏳ ${elapsed}s / ${timeoutSeconds}s`);
        lastLog = elapsed;
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return { filled: false, reason: "timeout" };
}

async function sendEmailNotification({ config, action, position, orderResult, selectedOB, breakoutPrice, currentPrice, deviationPercent, orderStrategy, balance }) {
  if (!config.emailRecipient || !config.emailConfig.auth.user) return;

  const transporter = nodemailer.createTransport(config.emailConfig);

  const emoji = position.side === SIDE.LONG ? "🟢" : "🔴";
  const direction = position.side === SIDE.LONG ? "做多" : "做空";
  const actionText = action === "OPEN" ? "开仓" : `加仓 #${position.additionCount}`;
  const strategyIcon = orderStrategy === "market" ? "⚡" : "📋";

  const subject = `${emoji} ${config.symbol} ${direction}${actionText} @ $${orderResult.executionPrice.toFixed(2)}`;

  const body = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      🤖 OB 交易系统 - ${actionText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${emoji} 交易对: ${config.symbol}
📊 方向: ${direction}
🔢 操作: ${actionText}
⏰ 时间: ${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 入场信息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

策略: ${strategyIcon} ${orderStrategy === "market" ? "市价单" : "限价单"}
突破价: $${breakoutPrice.toFixed(2)}
成交价: $${orderResult.executionPrice.toFixed(2)}
偏离: ${deviationPercent.toFixed(2)}%

${action === "OPEN" ? "仓位" : "新增"}: ${orderResult.executedSize.toFixed(4)} BTC
${action === "ADD" ? `总持仓: ${position.size.toFixed(4)} BTC\n平均价: $${position.avgEntryPrice.toFixed(2)}\n` : ''}
止损: $${position.stopLoss.toFixed(2)}
风险: ${((Math.abs(orderResult.executionPrice - position.stopLoss) * orderResult.executedSize / balance) * 100).toFixed(2)}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 账户
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

余额: $${balance.toFixed(2)}
杠杆: ${position.leverage}x
手续费: $${orderResult.fee.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 OB: ${selectedOB.type} | $${selectedOB.bottom.toFixed(2)}-$${selectedOB.top.toFixed(2)} | ${selectedOB.confidence}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  await transporter.sendMail({
    from: `"OB Bot" <${config.emailConfig.auth.user}>`,
    to: config.emailRecipient,
    subject, text: body,
    html: `<pre style="font-family: monospace; font-size: 12px; background: #1a1a1a; color: #e0e0e0; padding: 20px;">${body}</pre>`
  });
}

async function sendEmergencyAlert({ config, error, orderResult, selectedOB }) {
  if (!config.emailEnabled) return;

  try {
    const transporter = nodemailer.createTransport(config.emailConfig);

    await transporter.sendMail({
      from: `"OB Bot ALERT" <${config.emailConfig.auth.user}>`,
      to: config.emailRecipient,
      subject: "🚨 URGENT: Database Update Failed",
      text: `Order executed but DB failed!\n\nOrder ID: ${orderResult.orderId}\nPrice: ${orderResult.executionPrice}\nError: ${error}`,
      priority: "high"
    });
  } catch (e) {
    console.error('Emergency alert failed:', e);
  }
}