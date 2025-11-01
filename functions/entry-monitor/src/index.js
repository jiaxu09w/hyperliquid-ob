/**
 * Entry Monitor v3.1 - 智能混合入场策略
 *
 * 功能：
 * ✅ 智能入场（市价单 + 限价单混合）
 * ✅ 加仓逻辑（同方向新OB）
 * ✅ 激进止损（OB边缘）
 * ✅ API超时和重试
 * ✅ 状态一致性保证
 * ✅ 邮件通知
 */

const { Client, Databases, Query, ID } = require("node-appwrite");
const nodemailer = require("nodemailer");
const HyperliquidAPI = require("./hyperliquid");
const { COLLECTIONS, MARKETS, SIDE } = require("./constants");
const { checkAccountProtection, triggerCooldown } = require('./account-protection');
// ═════════════════════════════════════════════════════════════════════════
// 工具函数：重试机制
// ═════════════════════════════════════════════════════════════════════════

async function retryWithBackoff(
  fn,
  maxRetries = 3,
  initialDelay = 1000,
  fnName = "Operation"
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;

      const delay = initialDelay * Math.pow(2, i);
      console.log(
        `⚠️  ${fnName} failed (attempt ${
          i + 1
        }/${maxRetries}), retrying in ${delay}ms...`
      );
      console.log(`   Error: ${err.message}`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 主函数
// ═════════════════════════════════════════════════════════════════════════

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log("━".repeat(60));
    log("📊 Entry Monitor v3.1 - Smart Entry Strategy");
    log("━".repeat(60));

    // ═══════════════════════════════════════════════════════════════════════
    // 配置
    // ═══════════════════════════════════════════════════════════════════════

    const config = {
      // Appwrite
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,

      // Trading
      symbol: process.env.TRADING_SYMBOL || "BTCUSDT",
      tradingEnabled: process.env.TRADING_ENABLED === "true",
      leverage: parseInt(process.env.LEVERAGE) || 3,
      riskPercent: parseFloat(process.env.RISK_PER_TRADE) || 1.5,

      // Pyramiding
      maxAdditions: parseInt(process.env.MAX_ADDITIONS) || 2,
      scaleDownFactor: parseFloat(process.env.SCALE_DOWN_FACTOR) || 0.5,
      minProfitForAddition:
        parseFloat(process.env.MIN_PROFIT_FOR_ADDITION) || 1.0,

      // Strategy
      requireHighConfidence: process.env.REQUIRE_HIGH_CONFIDENCE === "true",

      // Smart Entry
      maxSlippageForMarket: parseFloat(process.env.MAX_SLIPPAGE_MARKET) || 0.5,
      maxSlippageForLimit: parseFloat(process.env.MAX_SLIPPAGE_LIMIT) || 2.0,
      limitOrderWaitTime: parseInt(process.env.LIMIT_ORDER_WAIT_TIME) || 60,
      limitPriceAdjustment:
        parseFloat(process.env.LIMIT_PRICE_ADJUSTMENT) || 0.3,

      // API
      apiTimeout: parseInt(process.env.API_TIMEOUT) || 10000,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,

      // Email
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

    log(`\n⚙️  Configuration:`);
    log(`   Symbol: ${config.symbol}`);
    log(`   Mode: ${config.tradingEnabled ? "🔴 LIVE" : "🧪 TEST"}`);
    log(`   Risk: ${config.riskPercent}% | Leverage: ${config.leverage}x`);
    log(`   Max additions: ${config.maxAdditions}`);
    log(`   Entry strategy: Smart Mixed (Market + Limit)`);
    log(`   └─ Market order if slippage < ${config.maxSlippageForMarket}%`);
    log(`   └─ Limit order if slippage < ${config.maxSlippageForLimit}%`);
    log(`   └─ Skip if slippage > ${config.maxSlippageForLimit}%`);

    // ═══════════════════════════════════════════════════════════════════════
    // 初始化
    // ═══════════════════════════════════════════════════════════════════════

    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    const hl = new HyperliquidAPI(
      process.env.HYPERLIQUID_PRIVATE_KEY,
      !config.tradingEnabled
    );

    // ═══════════════════════════════════════════════════════════════════════
    // 1. 检查现有持仓
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n1️⃣  Checking existing positions...`);

    const openPositions = await retryWithBackoff(
      () =>
        databases.listDocuments(config.databaseId, COLLECTIONS.POSITIONS, [
          Query.equal("symbol", config.symbol),
          Query.equal("status", "OPEN"),
          Query.limit(1),
        ]),
      3,
      1000,
      "List positions"
    );

    const hasPosition = openPositions.documents.length > 0;
    const existingPosition = hasPosition ? openPositions.documents[0] : null;

    if (hasPosition) {
      log(`   ✅ Found ${existingPosition.side} position`);
      log(`   Entry: $${existingPosition.avgEntryPrice.toFixed(2)}`);
      log(`   Size: ${existingPosition.size.toFixed(4)}`);
      log(
        `   Additions: ${existingPosition.additionCount}/${config.maxAdditions}`
      );
    } else {
      log(`   No open positions`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. 查找新 OB
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n2️⃣  Searching for new OBs...`);

    const unprocessedOBs = await retryWithBackoff(
      () =>
        databases.listDocuments(config.databaseId, COLLECTIONS.ORDER_BLOCKS, [
          Query.equal("symbol", config.symbol),
          Query.equal("isActive", true),
          Query.equal("isProcessed", false),
          Query.orderDesc("confirmationTime"),
          Query.limit(5),
        ]),
      3,
      1000,
      "List OBs"
    );

    if (unprocessedOBs.documents.length === 0) {
      log(`   No new OBs found`);
      return res.json({
        success: true,
        action: "no_signal",
        hasPosition,
      });
    }

    log(`   Found ${unprocessedOBs.documents.length} unprocessed OB(s)`);

    // ═══════════════════════════════════════════════════════════════════════
    // 3. 获取市场数据
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n3️⃣  Fetching market data...`);

    const currentPrice = await retryWithBackoff(
      () => hl.getPrice(config.symbol),
      3,
      2000,
      "Get price"
    );

    log(`   Current price: $${currentPrice.toFixed(2)}`);

    const balance = await retryWithBackoff(
      () => hl.getBalance(),
      3,
      2000,
      "Get balance"
    );

    log(`   Balance: $${balance.toFixed(2)}`);

    if (balance < 10) {
      error(`   ❌ Insufficient balance: $${balance.toFixed(2)}`);
      return res.json(
        {
          success: false,
          error: "Insufficient balance",
          balance,
        },
        400
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3.5 账户保护检查
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n3️⃣ .5 Account protection check...`);

    const protectionResult = await checkAccountProtection(
      databases,
      config.databaseId,
      hl,
      log
    );

    if (!protectionResult.allowed) {
      error(`\n🛑 Trading blocked by account protection:`);
      error(`   Reason: ${protectionResult.reason}`);
      error(`   Message: ${protectionResult.message}`);

      // 如果是严重问题（连续亏损、回撤），触发冷静期
      if (['consecutive_losses', 'max_drawdown', 'daily_loss_limit'].includes(protectionResult.reason)) {
        await triggerCooldown(
          databases,
          config.databaseId,
          protectionResult.reason,
          log
        );
      }

      return res.json({
        success: false,
        action: 'blocked_by_protection',
        protection: protectionResult,
        timestamp: new Date().toISOString()
      }, 403);
    }

    log(`   Stats: Balance $${protectionResult.stats.balance.toFixed(2)} | Daily PnL: $${protectionResult.stats.dailyPnL.toFixed(2)}`);

    // ═══════════════════════════════════════════════════════════════════════
    // 4. 评估 OB 和决定操作
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n4️⃣  Evaluating OBs...`);

    const marketConfig = MARKETS[config.symbol] || MARKETS.BTCUSDT;
    let selectedOB = null;
    let action = null;

    for (const ob of unprocessedOBs.documents) {
      log(`\n   ├─ OB ${ob.$id.substring(0, 8)}`);
      log(`   │  Type: ${ob.type}`);
      log(`   │  Range: $${ob.bottom.toFixed(2)} - $${ob.top.toFixed(2)}`);
      log(`   │  Confidence: ${ob.confidence}`);

      if (config.requireHighConfidence && ob.confidence !== "high") {
        log(`   │  ❌ Low confidence, skipping`);
        continue;
      }

      if (hasPosition) {
        // 检查加仓条件
        const isSameDirection =
          (existingPosition.side === SIDE.LONG && ob.type === "BULLISH") ||
          (existingPosition.side === SIDE.SHORT && ob.type === "BEARISH");

        if (!isSameDirection) {
          log(`   │  ⚠️  Different direction`);
          continue;
        }

        if (existingPosition.additionCount >= config.maxAdditions) {
          log(`   │  ⚠️  Max additions reached`);
          continue;
        }

        const unrealizedPnL =
          existingPosition.side === SIDE.LONG
            ? (currentPrice - existingPosition.avgEntryPrice) *
              existingPosition.size
            : (existingPosition.avgEntryPrice - currentPrice) *
              existingPosition.size;

        const unrealizedPnLPercent = (unrealizedPnL / balance) * 100;

        log(`   │  Current P&L: ${unrealizedPnLPercent.toFixed(2)}%`);

        if (unrealizedPnLPercent < config.minProfitForAddition) {
          log(
            `   │  ⚠️  Insufficient profit (min: ${config.minProfitForAddition}%)`
          );
          continue;
        }

        const lastOBBottom = existingPosition.lastOBBottom || 0;
        const lastOBTop = existingPosition.lastOBTop || Infinity;

        const isBetterOB =
          existingPosition.side === SIDE.LONG
            ? ob.bottom > lastOBBottom
            : ob.top < lastOBTop;

        if (!isBetterOB) {
          log(`   │  ⚠️  OB not better than previous`);
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
      log(`\n   No valid OB for trading`);
      return res.json({
        success: true,
        action: "no_valid_ob",
        hasPosition,
      });
    }

    log(
      `\n   ✅ Selected: ${action} with OB ${selectedOB.$id.substring(0, 8)}`
    );

    // ═══════════════════════════════════════════════════════════════════════
    // 5. 计算交易参数
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n5️⃣  Calculating position...`);

    const side = selectedOB.type === "BULLISH" ? SIDE.LONG : SIDE.SHORT;

    // 激进止损：OB边缘
    const stopLoss = side === SIDE.LONG ? selectedOB.bottom : selectedOB.top;

    log(`   Side: ${side}`);
    log(`   Stop Loss: $${stopLoss.toFixed(2)} (OB edge)`);

    let riskAmount, riskDistance, positionSize;

    if (action === "OPEN") {
      riskAmount = balance * (config.riskPercent / 100);
      riskDistance = Math.abs(currentPrice - stopLoss);
      positionSize = riskAmount / riskDistance;

      log(`   Risk: $${riskAmount.toFixed(2)} (${config.riskPercent}%)`);
    } else {
      const additionNumber = existingPosition.additionCount + 1;
      const scaleFactor = Math.pow(config.scaleDownFactor, additionNumber);
      const baseRisk = balance * (config.riskPercent / 100);
      riskAmount = baseRisk * scaleFactor;
      riskDistance = Math.abs(currentPrice - stopLoss);
      positionSize = riskAmount / riskDistance;

      log(`   Addition #${additionNumber}`);
      log(`   Scale factor: ${scaleFactor.toFixed(2)}x`);
      log(`   Risk: $${riskAmount.toFixed(2)}`);
    }

    log(`   Risk distance: $${riskDistance.toFixed(2)}`);
    log(`   Raw size: ${positionSize.toFixed(4)}`);

    positionSize =
      Math.floor(positionSize / marketConfig.sizeIncrement) *
      marketConfig.sizeIncrement;
    log(`   Adjusted size: ${positionSize.toFixed(4)}`);

    if (positionSize < marketConfig.minSize) {
      log(
        `   ❌ Size too small: ${positionSize.toFixed(4)} < ${
          marketConfig.minSize
        }`
      );
      return res.json({
        success: true,
        action: "size_too_small",
        calculatedSize: positionSize,
      });
    }

    const positionValue = positionSize * currentPrice;
    const requiredMargin = positionValue / config.leverage;

    log(`   Position value: $${positionValue.toFixed(2)}`);
    log(`   Required margin: $${requiredMargin.toFixed(2)}`);

    if (requiredMargin > balance * 0.95) {
      error("   ❌ Insufficient margin");
      return res.json({ success: false, error: "Insufficient margin" }, 400);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. 智能入场策略
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n6️⃣  Smart entry strategy...`);
    log(`   Mode: ${config.tradingEnabled ? "🔴 LIVE" : "🧪 TEST"}`);

    // 获取突破价格
    const breakoutPrice = getBreakoutPrice(selectedOB);
    log(`   OB breakout price: $${breakoutPrice.toFixed(2)}`);
    log(`   Current price: $${currentPrice.toFixed(2)}`);

    // 计算滑点
    const slippage = Math.abs(currentPrice - breakoutPrice) / breakoutPrice;
    const slippagePercent = slippage * 100;

    log(`   Slippage: ${slippagePercent.toFixed(2)}%`);

    let orderResult;
    let orderStrategy;
    let pendingDoc = null;

    // ═══════════════════════════════════════════════════════════════════════
    // 场景判断
    // ═══════════════════════════════════════════════════════════════════════

    if (slippagePercent <= config.maxSlippageForMarket) {
      // ═══════════════════════════════════════════════════════════════════
      // 场景 1: 小滑点 → 市价单
      // ═══════════════════════════════════════════════════════════════════

      log(`\n   ✅ Small slippage → Market order`);
      orderStrategy = "market";

      if (action === "OPEN") {
        pendingDoc = await databases.createDocument(
          config.databaseId,
          COLLECTIONS.POSITIONS,
          ID.unique(),
          {
            symbol: config.symbol,
            side,
            status: "PENDING",
            entryPrice: currentPrice,
            avgEntryPrice: currentPrice,
            size: positionSize,
            stopLoss,
            leverage: config.leverage,
            margin: requiredMargin,
            plannedRisk: riskAmount,
            openTime: new Date().toISOString(),
            lastChecked: new Date().toISOString(),
            relatedOB: selectedOB.$id,
            obConfidence: selectedOB.confidence,
            obType: selectedOB.type,
            obBottom: selectedOB.bottom,
            obTop: selectedOB.top,
            lastOBBottom: selectedOB.bottom,
            lastOBTop: selectedOB.top,
            breakoutPrice,
            strategyType: "ob_breakout",
            strategyVersion: "v3.1_smart_entry",
            additionCount: 0,
            orderStrategy: "market",
          }
        );
        log(`   💾 Created pending position`);
      }

      orderResult = await retryWithBackoff(
        () =>
          hl.placeOrderWithStopLoss({
            symbol: config.symbol,
            side,
            size: positionSize,
            entryPrice: currentPrice,
            stopLoss,
            orderType: "market",
          }),
        config.maxRetries,
        2000,
        "Place market order"
      );

      if (!orderResult.success && pendingDoc) {
        await databases.updateDocument(
          config.databaseId,
          COLLECTIONS.POSITIONS,
          pendingDoc.$id,
          { status: "FAILED", failureReason: orderResult.error }
        );
      }
    } else if (slippagePercent <= config.maxSlippageForLimit) {
      // ═══════════════════════════════════════════════════════════════════
      // 场景 2: 中等滑点 → 限价单
      // ═══════════════════════════════════════════════════════════════════

      log(`\n   ⏳ Medium slippage → Limit order strategy`);
      orderStrategy = "limit";

      // ✅ 修正：智能限价计算
      let limitPrice;

      if (side === SIDE.LONG) {
        // 做多：限价买单
        // 目标：在当前价下方，但不低于突破价太多
        const idealPrice =
          currentPrice * (1 - config.limitPriceAdjustment / 100); // 当前价下方
        const maxPrice = breakoutPrice * (1 + config.maxSlippageForLimit / 200); // 突破价上方（最多追高一半滑点）

        limitPrice = Math.min(idealPrice, maxPrice);

        // 确保限价单有意义（不能离当前价太远）
        if (limitPrice < currentPrice * 0.98) {
          log(`   ⚠️  Limit price too low, adjusting to currentPrice * 0.98`);
          limitPrice = currentPrice * 0.98;
        }
      } else {
        // 做空：限价卖单
        const idealPrice =
          currentPrice * (1 + config.limitPriceAdjustment / 100);
        const minPrice = breakoutPrice * (1 - config.maxSlippageForLimit / 200);

        limitPrice = Math.max(idealPrice, minPrice);

        if (limitPrice > currentPrice * 1.02) {
          log(`   ⚠️  Limit price too high, adjusting to currentPrice * 1.02`);
          limitPrice = currentPrice * 1.02;
        }
      }

      // ✅ 应用市场精度
      const marketConfig = MARKETS[config.symbol] || MARKETS.BTCUSDT;
      limitPrice = parseFloat(limitPrice.toFixed(marketConfig.pricePrecision));

      log(`   Breakout price: $${breakoutPrice.toFixed(2)}`);
      log(`   Current price: $${currentPrice.toFixed(2)}`);
      log(`   Limit price: $${limitPrice.toFixed(2)}`);
      log(
        `   Distance from current: ${(
          ((limitPrice - currentPrice) / currentPrice) *
          100
        ).toFixed(2)}%`
      );
      log(
        `   Distance from breakout: ${(
          ((limitPrice - breakoutPrice) / breakoutPrice) *
          100
        ).toFixed(2)}%`
      );

      if (action === "OPEN") {
        pendingDoc = await databases.createDocument(
          config.databaseId,
          COLLECTIONS.POSITIONS,
          ID.unique(),
          {
            symbol: config.symbol,
            side,
            status: "PENDING",
            entryPrice: limitPrice,
            avgEntryPrice: limitPrice,
            size: positionSize,
            stopLoss,
            leverage: config.leverage,
            margin: requiredMargin,
            plannedRisk: riskAmount,
            openTime: new Date().toISOString(),
            lastChecked: new Date().toISOString(),
            relatedOB: selectedOB.$id,
            obConfidence: selectedOB.confidence,
            obType: selectedOB.type,
            obBottom: selectedOB.bottom,
            obTop: selectedOB.top,
            lastOBBottom: selectedOB.bottom,
            lastOBTop: selectedOB.top,
            breakoutPrice,
            strategyType: "ob_breakout",
            strategyVersion: "v3.1_smart_entry",
            additionCount: 0,
            orderStrategy: "limit",
            limitPrice,
          }
        );
        log(`   💾 Created pending position with limit order`);
      }

      orderResult = await retryWithBackoff(
        () =>
          hl.placeOrderWithStopLoss({
            symbol: config.symbol,
            side,
            size: positionSize,
            entryPrice: limitPrice,
            stopLoss,
            orderType: "limit",
          }),
        config.maxRetries,
        2000,
        "Place limit order"
      );

      if (orderResult.success && orderResult.orderStatus === "resting") {
        log(`   📋 Limit order placed (${orderResult.orderId})`);
        log(`   ⏳ Waiting ${config.limitOrderWaitTime}s for fill...`);

        const fillResult = await waitForOrderFill(
          hl,
          orderResult.orderId,
          config.limitOrderWaitTime,
          log
        );

        if (fillResult.filled) {
          log(
            `   ✅ Limit order filled @ $${fillResult.executionPrice.toFixed(
              2
            )}`
          );

          // ✅ 检查实际成交价格是否合理
          const actualSlippage =
            (Math.abs(fillResult.executionPrice - breakoutPrice) /
              breakoutPrice) *
            100;
          log(
            `   Actual slippage from breakout: ${actualSlippage.toFixed(2)}%`
          );

          orderResult.executionPrice = fillResult.executionPrice;
          orderResult.executedSize = fillResult.executedSize;
          orderResult.fee = fillResult.fee;
          orderResult.orderStatus = "filled";
        } else {
          log(`   ⏭️  Limit order not filled (reason: ${fillResult.reason})`);
          log(`   Cancelling order...`);

          await hl.cancelOrder(orderResult.orderId);

          if (pendingDoc) {
            await databases.updateDocument(
              config.databaseId,
              COLLECTIONS.POSITIONS,
              pendingDoc.$id,
              {
                status: "CANCELLED",
                cancelReason: `limit_not_filled_${fillResult.reason}`,
                cancelledAt: new Date().toISOString(),
              }
            );
          }

          log(`\n   💡 OB not marked as processed (can retry next cycle)`);

          return res.json({
            success: true,
            action: "limit_order_not_filled",
            message: `Limit order not filled: ${fillResult.reason}`,
            canRetry: true,
            limitPrice,
            currentPrice,
            slippage: slippagePercent.toFixed(2) + "%",
          });
        }
      }
    } else {
      // ═══════════════════════════════════════════════════════════════════
      // 场景 3: 大滑点 → 跳过
      // ═══════════════════════════════════════════════════════════════════

      log(
        `\n   ⏭️  High slippage (${slippagePercent.toFixed(2)}% > ${
          config.maxSlippageForLimit
        }%)`
      );
      log(`   Skipping to avoid chasing price`);
      log(`   OB not marked (can retry if price pulls back)`);

      return res.json({
        success: true,
        action: "skipped_high_slippage",
        slippage: slippagePercent.toFixed(2) + "%",
        breakoutPrice,
        currentPrice,
        canRetry: true,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 验证订单结果
    // ═══════════════════════════════════════════════════════════════════════

    if (
      !orderResult ||
      !orderResult.success ||
      orderResult.orderStatus !== "filled"
    ) {
      error(`   ❌ Order failed: ${orderResult?.error || "Unknown error"}`);

      return res.json(
        {
          success: false,
          action: "order_failed",
          error: orderResult?.error,
          orderStrategy,
        },
        500
      );
    }

    log(`   ✅ Order executed successfully`);
    log(`   Order ID: ${orderResult.orderId}`);
    log(`   Execution: $${orderResult.executionPrice.toFixed(2)}`);
    log(`   Size: ${orderResult.executedSize.toFixed(4)}`);
    log(`   Fee: $${orderResult.fee.toFixed(2)}`);
    log(`   Strategy: ${orderStrategy}`);

    // ═══════════════════════════════════════════════════════════════════════
    // 7. 更新数据库
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n7️⃣  Updating database...`);

    const actualRisk =
      Math.abs(orderResult.executionPrice - stopLoss) *
      orderResult.executedSize;
    const actualRiskPercent = (actualRisk / balance) * 100;
    const actualSlippage =
      (Math.abs(orderResult.executionPrice - breakoutPrice) / breakoutPrice) *
      100;

    let finalPosition;

    if (action === "OPEN") {
      finalPosition = await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.POSITIONS,
        pendingDoc.$id,
        {
          status: "OPEN",
          entryPrice: orderResult.executionPrice,
          avgEntryPrice: orderResult.executionPrice,
          size: orderResult.executedSize,
          stopLossOrderId: orderResult.stopLossOrderId,
          liquidationPrice: orderResult.liquidationPrice || 0,
          actualRisk,
          actualRiskPercent,
          actualSlippage,
          entryFee: orderResult.fee,
          orderStrategy,
        }
      );

      log(`   ✅ Position updated to OPEN`);
    } else {
      const totalCost =
        existingPosition.avgEntryPrice * existingPosition.size +
        orderResult.executionPrice * orderResult.executedSize;
      const totalSize = existingPosition.size + orderResult.executedSize;
      const newAvgPrice = totalCost / totalSize;

      finalPosition = await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.POSITIONS,
        existingPosition.$id,
        {
          size: totalSize,
          avgEntryPrice: newAvgPrice,
          stopLoss,
          additionCount: existingPosition.additionCount + 1,
          lastOBBottom: selectedOB.bottom,
          lastOBTop: selectedOB.top,
          lastAdditionTime: new Date().toISOString(),
          entryFee: existingPosition.entryFee + orderResult.fee,

          [`addition${existingPosition.additionCount + 1}Price`]:
            orderResult.executionPrice,
          [`addition${existingPosition.additionCount + 1}Size`]:
            orderResult.executedSize,
          [`addition${existingPosition.additionCount + 1}Time`]:
            new Date().toISOString(),
          [`addition${existingPosition.additionCount + 1}Strategy`]:
            orderStrategy,
        }
      );

      log(
        `   ✅ Position updated with addition #${
          existingPosition.additionCount + 1
        }`
      );
      log(`   New avg price: $${newAvgPrice.toFixed(2)}`);
      log(`   New total size: ${totalSize.toFixed(4)}`);
    }

    await databases.updateDocument(
      config.databaseId,
      COLLECTIONS.ORDER_BLOCKS,
      selectedOB.$id,
      {
        isProcessed: true,
        processedAt: new Date().toISOString(),
        processedReason:
          action === "OPEN" ? "position_opened" : "position_added",
        processedPrice: orderResult.executionPrice,
      }
    );

    log(`   ✅ OB marked as processed`);

    // ═══════════════════════════════════════════════════════════════════════
    // 8. 发送邮件
    // ═══════════════════════════════════════════════════════════════════════

    if (config.emailEnabled) {
      log(`\n8️⃣  Sending email notification...`);

      try {
        await sendEmailNotification({
          config,
          action,
          position: finalPosition,
          orderResult,
          selectedOB,
          breakoutPrice,
          currentPrice,
          slippagePercent: actualSlippage,
          orderStrategy,
          balance,
          log,
        });
        log(`   ✅ Email sent`);
      } catch (emailErr) {
        error(`   ⚠️  Email failed: ${emailErr.message}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 完成
    // ═══════════════════════════════════════════════════════════════════════

    const duration = Date.now() - startTime;

    log(`\n${"━".repeat(60)}`);
    log(`✅ Entry Monitor Completed in ${duration}ms`);
    log(`${"━".repeat(60)}\n`);

    return res.json({
      success: true,
      action: action === "OPEN" ? "position_opened" : "position_added",
      position: {
        id: finalPosition.$id,
        symbol: config.symbol,
        side,
        entryPrice: orderResult.executionPrice,
        avgEntryPrice: finalPosition.avgEntryPrice,
        size: finalPosition.size,
        stopLoss,
        risk: actualRiskPercent.toFixed(2) + "%",
        additionCount: finalPosition.additionCount,
      },
      order: {
        orderId: orderResult.orderId,
        executionPrice: orderResult.executionPrice,
        breakoutPrice,
        slippage: actualSlippage.toFixed(2) + "%",
        strategy: orderStrategy,
        fee: orderResult.fee,
      },
      duration,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    error(`\n❌ Critical Error: ${err.message}`);
    error(err.stack);

    return res.json(
      {
        success: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      },
      500
    );
  }
};

// ═════════════════════════════════════════════════════════════════════════
// 辅助函数
// ═════════════════════════════════════════════════════════════════════════

function getBreakoutPrice(ob) {
  if (ob.breakoutPrice) {
    return ob.breakoutPrice;
  }
  if (ob.confirmationCandleClose) {
    return ob.confirmationCandleClose;
  }
  return ob.type === "BULLISH" ? ob.top : ob.bottom;
}

async function waitForOrderFill(hl, orderId, timeoutSeconds, log) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  const checkInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const orderStatus = await hl.getOrderStatus(orderId);

      if (orderStatus.status === "filled") {
        return {
          filled: true,
          executionPrice: orderStatus.avgPrice,
          executedSize: orderStatus.filledSize,
          fee: orderStatus.fee,
        };
      }

      if (
        orderStatus.status === "cancelled" ||
        orderStatus.status === "rejected"
      ) {
        return { filled: false, reason: orderStatus.status };
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed % 10 === 0) {
        log(`   ⏳ Waiting... (${elapsed}s / ${timeoutSeconds}s)`);
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    } catch (err) {
      log(`   ⚠️  Error checking order: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  }

  return { filled: false, reason: "timeout" };
}

async function sendEmailNotification({
  config,
  action,
  position,
  orderResult,
  selectedOB,
  breakoutPrice,
  currentPrice,
  slippagePercent,
  orderStrategy,
  balance,
  log,
}) {
  if (
    !config.emailRecipient ||
    !config.emailConfig.auth.user ||
    !config.emailConfig.auth.pass
  ) {
    return;
  }

  const transporter = nodemailer.createTransport(config.emailConfig);

  const isLong = position.side === SIDE.LONG;
  const emoji = isLong ? "🟢" : "🔴";
  const direction = isLong ? "做多" : "做空";
  const actionText =
    action === "OPEN" ? "开仓" : `加仓 #${position.additionCount}`;
  const strategyEmoji = orderStrategy === "market" ? "⚡" : "📋";
  const strategyText = orderStrategy === "market" ? "市价单" : "限价单";

  const nzTime = new Date().toLocaleString("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const subject = `${emoji} ${
    config.symbol
  } ${direction}${actionText} @ $${orderResult.executionPrice.toFixed(
    2
  )} (${strategyEmoji}${strategyText})`;

  const body = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      🤖 OB 自动交易系统 - ${actionText}通知
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${emoji} 交易对: ${config.symbol}
📊 方向:   ${direction} (${position.side})
🔢 操作:   ${actionText}
⏰ 时间:   ${nzTime} NZDT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 入场信息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

入场策略:     ${strategyEmoji} ${strategyText}
OB 突破价:    $${breakoutPrice.toFixed(2)}
实际成交:     $${orderResult.executionPrice.toFixed(2)}
滑点:         ${slippagePercent.toFixed(2)}%

${
  action === "OPEN" ? "仓位" : "新增"
}大小:     ${orderResult.executedSize.toFixed(4)} ${config.symbol.replace(
    "USDT",
    ""
  )}

${
  action === "ADD"
    ? `平均价格:     $${position.avgEntryPrice.toFixed(2)}
总持仓:       ${position.size.toFixed(4)} ${config.symbol.replace("USDT", "")}
加仓次数:     ${position.additionCount}

`
    : ""
}止损价格:     $${position.stopLoss.toFixed(2)} ⚡ (OB边缘)
止损距离:     ${Math.abs(
    ((position.stopLoss - orderResult.executionPrice) /
      orderResult.executionPrice) *
      100
  ).toFixed(2)}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 风险管理
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

账户余额:     $${balance.toFixed(2)}
杠杆倍数:     ${position.leverage}x
保证金:       $${position.margin.toFixed(2)}
${
  action === "OPEN"
    ? `计划风险:     $${position.plannedRisk.toFixed(2)} (${
        config.riskPercent
      }%)`
    : ""
}
实际风险:     $${position.actualRisk.toFixed(
    2
  )} (${position.actualRiskPercent.toFixed(2)}%)
手续费:       $${orderResult.fee.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Order Block 信息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

类型:         ${selectedOB.type} OB
区间:         $${selectedOB.bottom.toFixed(2)} - $${selectedOB.top.toFixed(2)}
置信度:       ${selectedOB.confidence === "high" ? "⭐⭐⭐ 高" : "⭐⭐ 中"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 市场状态
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

入场时价格:   $${currentPrice.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 订单详情
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

订单 ID:      ${orderResult.orderId}
持仓 ID:      ${position.$id}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📱 查看持仓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${config.tradingEnabled ? "🔴 主网" : "🧪 测试网"}: https://app.hyperliquid${
    config.tradingEnabled ? "" : "-testnet"
  }.xyz/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  await transporter.sendMail({
    from: `"OB Trading Bot" <${config.emailConfig.auth.user}>`,
    to: config.emailRecipient,
    subject: subject,
    text: body,
    html: `<pre style="font-family: 'Courier New', monospace; font-size: 12px; line-height: 1.4;">${body}</pre>`,
  });
}
