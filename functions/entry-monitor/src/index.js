/**
 * Entry Monitor v3.2 - 真正的突破入场策略
 *
 * 核心策略：
 * ✅ 检测到OB突破（配合成交量确认）后，在5-15分钟内入场
 * ✅ 市价单：价格偏离<0.8%
 * ✅ 限价单：价格偏离0.8%-2.0%
 * ✅ 跳过：价格偏离>2.0% 或 OB年龄>60分钟
 * 
 * 修复：
 * ✅ OB过期机制
 * ✅ 准确的命名（priceDeviation而非slippage）
 * ✅ 优化限价单价格
 * ✅ 改进加仓逻辑
 * ✅ 增强错误处理
 * ✅ 配置验证
 */

const { Client, Databases, Query, ID } = require("node-appwrite");
const nodemailer = require("nodemailer");
const HyperliquidAPI = require("./hyperliquid");
const { COLLECTIONS, MARKETS, SIDE, OB_TYPE } = require("./constants");
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
        `⚠️  ${fnName} failed (attempt ${i + 1}/${maxRetries}), retrying in ${delay}ms...`
      );
      console.log(`   Error: ${err.message}`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 配置验证
// ═════════════════════════════════════════════════════════════════════════

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

  if (config.maxDeviationForMarket > config.maxDeviationForLimit) {
    errors.push('MAX_DEVIATION_MARKET must be <= MAX_DEVIATION_LIMIT');
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
    log("📊 Entry Monitor v3.2 - Breakout Entry Strategy");
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
      leverage: parseInt(process.env.LEVERAGE) || 2,
      riskPercent: parseFloat(process.env.RISK_PER_TRADE) || 1.0,

      // Pyramiding
      maxAdditions: parseInt(process.env.MAX_ADDITIONS) || 1,
      scaleDownFactor: parseFloat(process.env.SCALE_DOWN_FACTOR) || 0.5,
      minProfitForAddition: parseFloat(process.env.MIN_PROFIT_FOR_ADDITION) || 1.5,

      // Strategy
      requireHighConfidence: process.env.REQUIRE_HIGH_CONFIDENCE === "true",
      
      // ✅ 突破入场策略（基于价格偏离度，非滑点）
      maxDeviationForMarket: parseFloat(process.env.MAX_DEVIATION_MARKET) || 0.8,  // 0.8%
      maxDeviationForLimit: parseFloat(process.env.MAX_DEVIATION_LIMIT) || 2.0,    // 2.0%
      limitOrderWaitTime: parseInt(process.env.LIMIT_ORDER_WAIT_TIME) || 240,      // 4分钟
      limitPriceAdjustment: parseFloat(process.env.LIMIT_PRICE_ADJUSTMENT) || 0.2, // 0.2%
      
      // ✅ OB过期机制
      maxOBAgeMinutes: parseInt(process.env.MAX_OB_AGE_MINUTES) || 60,  // 60分钟

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

    // ✅ 验证配置
    try {
      validateConfig(config);
    } catch (validationErr) {
      error(`❌ ${validationErr.message}`);
      return res.json({
        success: false,
        error: validationErr.message
      }, 400);
    }

    log(`\n⚙️  Configuration:`);
    log(`   Symbol: ${config.symbol}`);
    log(`   Mode: ${config.tradingEnabled ? "🔴 LIVE" : "🧪 TESTNET"}`);
    log(`   Risk: ${config.riskPercent}% | Leverage: ${config.leverage}x`);
    log(`   Max additions: ${config.maxAdditions}`);
    log(`   Entry strategy: Breakout + Volume Confirmation`);
    log(`   └─ Market order if deviation < ${config.maxDeviationForMarket}%`);
    log(`   └─ Limit order if deviation < ${config.maxDeviationForLimit}%`);
    log(`   └─ Skip if deviation > ${config.maxDeviationForLimit}% or age > ${config.maxOBAgeMinutes}min`);

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
      log(`   Additions: ${existingPosition.additionCount}/${config.maxAdditions}`);
    } else {
      log(`   No open positions`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. 查找新 OB
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n2️⃣  Searching for unprocessed OBs...`);

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

    log(`\n3️⃣.5 Account protection check...`);

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

      // 如果是严重问题，触发冷静期
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

    log(`   ✅ Protection OK - Balance: $${protectionResult.stats.balance.toFixed(2)} | Daily P&L: $${protectionResult.stats.dailyPnL.toFixed(2)}`);

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
      log(`   │  Confirmed: ${new Date(ob.confirmationTime).toISOString()}`);

      // ═══════════════════════════════════════════════════════════════════
      // ✅ OB年龄检查（过期机制）
      // ═══════════════════════════════════════════════════════════════════
      
      const obAgeMinutes = (Date.now() - new Date(ob.confirmationTime)) / (1000 * 60);
      log(`   │  Age: ${obAgeMinutes.toFixed(1)} min (max: ${config.maxOBAgeMinutes})`);

      if (obAgeMinutes > config.maxOBAgeMinutes) {
        log(`   │  ⏰ OB EXPIRED - Marking as processed`);
        
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

      // ✅ 置信度检查
      if (config.requireHighConfidence && ob.confidence !== "high") {
        log(`   │  ❌ Low confidence - Required: high, Got: ${ob.confidence}`);
        continue;
      }

      // ✅ 成交量二次确认（Scanner已验证，这里再次确认）
      if (ob.volume && ob.volume > 0) {
        log(`   │  ✅ Volume confirmed: ${ob.volume.toFixed(0)}`);
      } else {
        log(`   │  ⚠️  Volume data missing - Proceeding with caution`);
      }

      if (hasPosition) {
        // ═══════════════════════════════════════════════════════════════════
        // 检查加仓条件
        // ═══════════════════════════════════════════════════════════════════
        
        const isSameDirection =
          (existingPosition.side === SIDE.LONG && ob.type === OB_TYPE.BULLISH) ||
          (existingPosition.side === SIDE.SHORT && ob.type === OB_TYPE.BEARISH);

        if (!isSameDirection) {
          log(`   │  ⚠️  Different direction (Position: ${existingPosition.side}, OB: ${ob.type})`);
          continue;
        }

        if (existingPosition.additionCount >= config.maxAdditions) {
          log(`   │  ⚠️  Max additions reached (${existingPosition.additionCount}/${config.maxAdditions})`);
          continue;
        }

        // 计算未实现盈亏
        const unrealizedPnL =
          existingPosition.side === SIDE.LONG
            ? (currentPrice - existingPosition.avgEntryPrice) * existingPosition.size
            : (existingPosition.avgEntryPrice - currentPrice) * existingPosition.size;

        const unrealizedPnLPercent = (unrealizedPnL / balance) * 100;

        log(`   │  Current P&L: ${unrealizedPnLPercent >= 0 ? '+' : ''}${unrealizedPnLPercent.toFixed(2)}%`);

        if (unrealizedPnLPercent < config.minProfitForAddition) {
          log(`   │  ⚠️  Insufficient profit (need: ${config.minProfitForAddition}%, have: ${unrealizedPnLPercent.toFixed(2)}%)`);
          continue;
        }

        // ✅ 改进的加仓逻辑：允许合理范围内的OB
        const lastOBBottom = existingPosition.lastOBBottom || 0;
        const lastOBTop = existingPosition.lastOBTop || Infinity;

        // 计算OB距离
        const obDistance = existingPosition.side === SIDE.LONG
          ? Math.abs(ob.bottom - lastOBBottom) / lastOBBottom
          : Math.abs(ob.top - lastOBTop) / lastOBTop;

        // 检查是否明显更好
        const significantlyBetter = 
          (existingPosition.side === SIDE.LONG && ob.bottom > lastOBBottom * 1.02) ||
          (existingPosition.side === SIDE.SHORT && ob.top < lastOBTop * 0.98);

        // 或在合理范围内且高置信度
        const withinRangeAndConfident = obDistance < 0.05 && ob.confidence === 'high';

        const isSuitableForAddition = significantlyBetter || withinRangeAndConfident;

        if (!isSuitableForAddition) {
          log(`   │  ⚠️  OB not suitable for addition`);
          log(`   │     Distance from last OB: ${(obDistance * 100).toFixed(2)}%`);
          log(`   │     Significantly better: ${significantlyBetter ? 'Yes' : 'No'}`);
          log(`   │     Within range & confident: ${withinRangeAndConfident ? 'Yes' : 'No'}`);
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
      log(`\n   ⏭️  No valid OB for trading`);
      return res.json({
        success: true,
        action: "no_valid_ob",
        hasPosition,
        checkedOBs: unprocessedOBs.documents.length
      });
    }

    log(`\n   ✅ Selected: ${action} with OB ${selectedOB.$id.substring(0, 8)}`);
    log(`      Type: ${selectedOB.type}`);
    log(`      Confidence: ${selectedOB.confidence}`);
    log(`      Age: ${((Date.now() - new Date(selectedOB.confirmationTime)) / (1000 * 60)).toFixed(1)} min`);

    // ═══════════════════════════════════════════════════════════════════════
    // 5. 计算交易参数
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n5️⃣  Calculating position parameters...`);

    const side = selectedOB.type === OB_TYPE.BULLISH ? SIDE.LONG : SIDE.SHORT;

    // ✅ 激进止损：OB边缘（已考虑成交量确认）
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

    log(`   Risk distance: $${riskDistance.toFixed(2)} (${((riskDistance / currentPrice) * 100).toFixed(2)}%)`);
    log(`   Raw size: ${positionSize.toFixed(4)}`);

    positionSize =
      Math.floor(positionSize / marketConfig.sizeIncrement) *
      marketConfig.sizeIncrement;
    log(`   Adjusted size: ${positionSize.toFixed(4)}`);

    if (positionSize < marketConfig.minSize) {
      log(`   ❌ Size too small: ${positionSize.toFixed(4)} < ${marketConfig.minSize}`);
      
      // 标记OB为已处理（避免重复尝试）
      await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        selectedOB.$id,
        {
          isProcessed: true,
          processedAt: new Date().toISOString(),
          processedReason: 'size_too_small',
          processedPrice: currentPrice
        }
      );
      
      return res.json({
        success: true,
        action: "size_too_small",
        calculatedSize: positionSize,
        minSize: marketConfig.minSize
      });
    }

    const positionValue = positionSize * currentPrice;
    const requiredMargin = positionValue / config.leverage;

    log(`   Position value: $${positionValue.toFixed(2)}`);
    log(`   Required margin: $${requiredMargin.toFixed(2)}`);

    if (requiredMargin > balance * 0.95) {
      error("   ❌ Insufficient margin");
      return res.json({ 
        success: false, 
        error: "Insufficient margin",
        required: requiredMargin,
        available: balance * 0.95
      }, 400);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. 智能入场策略（突破入场）
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n6️⃣  Entry strategy (Breakout + Volume)...`);
    log(`   Mode: ${config.tradingEnabled ? "🔴 LIVE" : "🧪 TESTNET"}`);

    // ✅ 获取突破价格
    const breakoutPrice = getBreakoutPrice(selectedOB);
    log(`   Breakout price: $${breakoutPrice.toFixed(2)}`);
    log(`   Current price: $${currentPrice.toFixed(2)}`);

    // ✅ 计算价格偏离度（不是滑点！）
    const priceDeviation = Math.abs(currentPrice - breakoutPrice) / breakoutPrice;
    const deviationPercent = priceDeviation * 100;

    log(`   Price deviation: ${deviationPercent.toFixed(2)}% (time delay: 5-15 min expected)`);

    let orderResult;
    let orderStrategy;
    let pendingDoc = null;

    // ═══════════════════════════════════════════════════════════════════════
    // 决策矩阵
    // ═══════════════════════════════════════════════════════════════════════

    if (deviationPercent <= config.maxDeviationForMarket) {
      // ═══════════════════════════════════════════════════════════════════
      // 场景 1: 价格仍接近突破点 → 市价单
      // ═══════════════════════════════════════════════════════════════════

      log(`\n   ✅ Price near breakout (<${config.maxDeviationForMarket}%) → Market order`);
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
            strategyVersion: "v3.2_breakout_entry",
            additionCount: 0,
            orderStrategy: "market",
          }
        );
        log(`   💾 Created pending position document`);
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

    } else if (deviationPercent <= config.maxDeviationForLimit) {
      // ═══════════════════════════════════════════════════════════════════
      // 场景 2: 价格已偏离但可接受 → 限价单（等待小幅回调）
      // ═══════════════════════════════════════════════════════════════════

      log(`\n   📋 Price deviated moderately (${deviationPercent.toFixed(2)}%) → Limit order`);
      orderStrategy = "limit";

      // ✅ 优化的限价单价格计算
      let limitPrice;

      if (side === SIDE.LONG) {
        // 做多：限价买单在当前价下方，追求快速成交
        limitPrice = currentPrice * (1 - config.limitPriceAdjustment / 100);
        
        // 确保不会低于OB底部（避免在OB外入场）
        if (limitPrice < selectedOB.bottom) {
          limitPrice = selectedOB.bottom * 1.001;  // OB底部上方0.1%
          log(`   ⚠️  Adjusted limit price to OB bottom + 0.1%`);
        }
      } else {
        // 做空：限价卖单在当前价上方
        limitPrice = currentPrice * (1 + config.limitPriceAdjustment / 100);
        
        if (limitPrice > selectedOB.top) {
          limitPrice = selectedOB.top * 0.999;
          log(`   ⚠️  Adjusted limit price to OB top - 0.1%`);
        }
      }

      // 应用市场精度
      limitPrice = parseFloat(limitPrice.toFixed(marketConfig.pricePrecision));

      log(`   Limit price: $${limitPrice.toFixed(2)}`);
      log(`   Distance from current: ${(((limitPrice - currentPrice) / currentPrice) * 100).toFixed(2)}%`);
      log(`   Distance from breakout: ${(((limitPrice - breakoutPrice) / breakoutPrice) * 100).toFixed(2)}%`);

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
            strategyVersion: "v3.2_breakout_entry",
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
        log(`   📋 Limit order placed: ${orderResult.orderId}`);
        log(`   ⏳ Waiting up to ${config.limitOrderWaitTime}s for fill...`);

        const fillResult = await waitForOrderFill(
          hl,
          orderResult.orderId,
          config.limitOrderWaitTime,
          log
        );

        if (fillResult.filled) {
          log(`   ✅ Limit order FILLED @ $${fillResult.executionPrice.toFixed(2)}`);

          orderResult.executionPrice = fillResult.executionPrice;
          orderResult.executedSize = fillResult.executedSize;
          orderResult.fee = fillResult.fee;
          orderResult.orderStatus = "filled";
        } else {
          log(`   ⏭️  Limit order NOT filled (${fillResult.reason})`);
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

          log(`\n   💡 OB NOT marked as processed (will retry next cycle or expire)`);

          return res.json({
            success: true,
            action: "limit_order_not_filled",
            message: `Limit order not filled within ${config.limitOrderWaitTime}s`,
            reason: fillResult.reason,
            canRetry: true,
            limitPrice,
            currentPrice,
            deviation: deviationPercent.toFixed(2) + "%",
          });
        }
      }

    } else {
      // ═══════════════════════════════════════════════════════════════════
      // 场景 3: 价格偏离太大 → 跳过（OB可能失效）
      // ═══════════════════════════════════════════════════════════════════

      log(`\n   ⏭️  Price deviated too much (${deviationPercent.toFixed(2)}% > ${config.maxDeviationForLimit}%)`);
      log(`   OB likely invalid or missed entry window`);
      log(`   NOT marking as processed (will expire if persists)`);

      return res.json({
        success: true,
        action: "skipped_large_deviation",
        deviation: deviationPercent.toFixed(2) + "%",
        breakoutPrice,
        currentPrice,
        maxAllowed: config.maxDeviationForLimit + "%",
        obAge: ((Date.now() - new Date(selectedOB.confirmationTime)) / (1000 * 60)).toFixed(1) + " min",
        canRetry: true,
        willExpireIn: (config.maxOBAgeMinutes - (Date.now() - new Date(selectedOB.confirmationTime)) / (1000 * 60)).toFixed(1) + " min"
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 验证订单结果
    // ═══════════════════════════════════════════════════════════════════════

    if (!orderResult || !orderResult.success || orderResult.orderStatus !== "filled") {
      error(`   ❌ Order failed: ${orderResult?.error || "Unknown error"}`);

      // 如果是订单错误，标记OB为已处理（避免重复失败）
      if (orderResult?.error && !orderResult?.error.includes('network')) {
        await databases.updateDocument(
          config.databaseId,
          COLLECTIONS.ORDER_BLOCKS,
          selectedOB.$id,
          {
            isProcessed: true,
            processedAt: new Date().toISOString(),
            processedReason: 'order_failed',
            processedPrice: currentPrice,
            metadata: JSON.stringify({ error: orderResult.error })
          }
        );
      }

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

    log(`\n   ✅ Order executed successfully`);
    log(`   Order ID: ${orderResult.orderId}`);
    log(`   Execution price: $${orderResult.executionPrice.toFixed(2)}`);
    log(`   Executed size: ${orderResult.executedSize.toFixed(4)}`);
    log(`   Fee: $${orderResult.fee.toFixed(2)}`);
    log(`   Strategy: ${orderStrategy}`);

    // ═══════════════════════════════════════════════════════════════════════
    // 7. 更新数据库
    // ═══════════════════════════════════════════════════════════════════════

    log(`\n7️⃣  Updating database...`);

    const actualRisk =
      Math.abs(orderResult.executionPrice - stopLoss) * orderResult.executedSize;
    const actualRiskPercent = (actualRisk / balance) * 100;
    const actualDeviation =
      (Math.abs(orderResult.executionPrice - breakoutPrice) / breakoutPrice) * 100;

    let finalPosition;

    try {
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
            actualDeviation,
            entryFee: orderResult.fee,
            orderStrategy,
            executedAt: new Date().toISOString()
          }
        );

        log(`   ✅ Position document updated to OPEN`);

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

        log(`   ✅ Position updated with addition #${existingPosition.additionCount + 1}`);
        log(`   New avg price: $${newAvgPrice.toFixed(2)}`);
        log(`   New total size: ${totalSize.toFixed(4)}`);
      }

      // 标记OB为已处理
      await databases.updateDocument(
        config.databaseId,
        COLLECTIONS.ORDER_BLOCKS,
        selectedOB.$id,
        {
          isProcessed: true,
          processedAt: new Date().toISOString(),
          processedReason: action === "OPEN" ? "position_opened" : "position_added",
          processedPrice: orderResult.executionPrice,
        }
      );

      log(`   ✅ OB marked as processed`);

    } catch (dbErr) {
      error(`   ❌ Database update failed: ${dbErr.message}`);
      error(`   ⚠️  Order was executed but database not updated!`);
      error(`   ⚠️  Manual intervention may be required`);
      
      // 发送紧急邮件通知
      if (config.emailEnabled) {
        await sendEmergencyAlert({
          config,
          error: dbErr.message,
          orderResult,
          selectedOB,
          log
        });
      }
      
      return res.json({
        success: false,
        action: "database_update_failed",
        error: dbErr.message,
        orderExecuted: true,
        orderId: orderResult.orderId,
        executionPrice: orderResult.executionPrice,
        warning: "Order executed but database not updated - manual check required"
      }, 500);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 8. 发送邮件通知
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
          deviationPercent: actualDeviation,
          orderStrategy,
          balance,
          log,
        });
        log(`   ✅ Email notification sent`);
      } catch (emailErr) {
        error(`   ⚠️  Email notification failed: ${emailErr.message}`);
        // 不阻断主流程
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 完成
    // ═══════════════════════════════════════════════════════════════════════

    const duration = Date.now() - startTime;

    log(`\n${"━".repeat(60)}`);
    log(`✅ Entry Monitor completed in ${duration}ms`);
    log(`   Action: ${action === "OPEN" ? "Position Opened" : "Position Added"}`);
    log(`   Entry: $${orderResult.executionPrice.toFixed(2)}`);
    log(`   Size: ${orderResult.executedSize.toFixed(4)}`);
    log(`   Strategy: ${orderStrategy}`);
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
        deviation: actualDeviation.toFixed(2) + "%",
        strategy: orderStrategy,
        fee: orderResult.fee,
      },
      performance: {
        duration,
        obAge: ((Date.now() - new Date(selectedOB.confirmationTime)) / (1000 * 60)).toFixed(1) + " min",
        priceDeviation: deviationPercent.toFixed(2) + "%"
      },
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    error(`\n❌ Critical Error: ${err.message}`);
    error(err.stack);

    return res.json(
      {
        success: false,
        error: err.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
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
  // 优先级：1. breakoutPrice, 2. confirmationCandleClose, 3. OB边缘
  if (ob.breakoutPrice && ob.breakoutPrice > 0) {
    return ob.breakoutPrice;
  }
  if (ob.confirmationCandleClose && ob.confirmationCandleClose > 0) {
    return ob.confirmationCandleClose;
  }
  // 降级：使用OB边缘
  return ob.type === OB_TYPE.BULLISH ? ob.top : ob.bottom;
}

async function waitForOrderFill(hl, orderId, timeoutSeconds, log) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  const checkInterval = 2000;  // 每2秒检查一次

  let lastLogTime = 0;

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

      if (orderStatus.status === "cancelled" || orderStatus.status === "rejected") {
        return { 
          filled: false, 
          reason: orderStatus.status 
        };
      }

      // 每10秒输出一次进度
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed - lastLogTime >= 10) {
        log(`   ⏳ Waiting for fill... (${elapsed}s / ${timeoutSeconds}s)`);
        lastLogTime = elapsed;
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));

    } catch (err) {
      log(`   ⚠️  Error checking order status: ${err.message}`);
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
  deviationPercent,
  orderStrategy,
  balance,
  log,
}) {
  if (
    !config.emailRecipient ||
    !config.emailConfig.auth.user ||
    !config.emailConfig.auth.pass
  ) {
    log(`   ⚠️  Email config incomplete, skipping`);
    return;
  }

  const transporter = nodemailer.createTransport(config.emailConfig);

  const isLong = position.side === SIDE.LONG;
  const emoji = isLong ? "🟢" : "🔴";
  const direction = isLong ? "做多" : "做空";
  const actionText = action === "OPEN" ? "开仓" : `加仓 #${position.additionCount}`;
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

  const subject = `${emoji} ${config.symbol} ${direction}${actionText} @ $${orderResult.executionPrice.toFixed(2)} (${strategyEmoji}${strategyText})`;

  const body = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      🤖 OB 自动交易系统 - ${actionText}通知
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${emoji} 交易对: ${config.symbol}
📊 方向:   ${direction} (${position.side})
🔢 操作:   ${actionText}
⏰ 时间:   ${nzTime} NZDT
🌐 环境:   ${config.tradingEnabled ? "🔴 主网" : "🧪 测试网"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 入场信息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

入场策略:     ${strategyEmoji} ${strategyText} (突破+成交量)
OB 突破价:    $${breakoutPrice.toFixed(2)}
实际成交:     $${orderResult.executionPrice.toFixed(2)}
价格偏离:     ${deviationPercent.toFixed(2)}%

${action === "OPEN" ? "仓位" : "新增"}大小:     ${orderResult.executedSize.toFixed(4)} ${config.symbol.replace("USDT", "")}

${action === "ADD" ? `平均价格:     $${position.avgEntryPrice.toFixed(2)}
总持仓:       ${position.size.toFixed(4)} ${config.symbol.replace("USDT", "")}
加仓次数:     ${position.additionCount}

` : ""}止损价格:     $${position.stopLoss.toFixed(2)} ⚡ (OB边缘)
止损距离:     ${Math.abs(((position.stopLoss - orderResult.executionPrice) / orderResult.executionPrice) * 100).toFixed(2)}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 风险管理
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

账户余额:     $${balance.toFixed(2)}
杠杆倍数:     ${position.leverage}x
保证金:       $${position.margin.toFixed(2)}
${action === "OPEN" ? `计划风险:     $${position.plannedRisk.toFixed(2)} (${config.riskPercent}%)` : ""}
实际风险:     $${position.actualRisk.toFixed(2)} (${position.actualRiskPercent.toFixed(2)}%)
手续费:       $${orderResult.fee.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Order Block 信息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

类型:         ${selectedOB.type} OB
区间:         $${selectedOB.bottom.toFixed(2)} - $${selectedOB.top.toFixed(2)}
置信度:       ${selectedOB.confidence === "high" ? "⭐⭐⭐ 高" : "⭐⭐ 中"}
成交量:       ${selectedOB.volume ? selectedOB.volume.toFixed(0) : "N/A"}

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

${config.tradingEnabled ? "🔴 主网" : "🧪 测试网"}: https://app.hyperliquid${config.tradingEnabled ? "" : "-testnet"}.xyz/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  这是自动生成的通知，请勿直接回复
💡 请前往 Hyperliquid 查看实时状态
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  await transporter.sendMail({
    from: `"OB Trading Bot" <${config.emailConfig.auth.user}>`,
    to: config.emailRecipient,
    subject: subject,
    text: body,
    html: `<pre style="font-family: 'Courier New', monospace; font-size: 12px; line-height: 1.4; background: #1a1a1a; color: #e0e0e0; padding: 20px; border-radius: 5px;">${body}</pre>`,
  });
}

async function sendEmergencyAlert({ config, error, orderResult, selectedOB, log }) {
  if (!config.emailEnabled || !config.emailRecipient) return;

  try {
    const transporter = nodemailer.createTransport(config.emailConfig);

    const subject = "🚨 URGENT: Database Update Failed After Order Execution";
    const body = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      🚨 EMERGENCY ALERT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  DATABASE UPDATE FAILED
⚠️  ORDER WAS EXECUTED
⚠️  MANUAL INTERVENTION REQUIRED

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Issue:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Error: ${error}

Order Details:
- Order ID: ${orderResult.orderId}
- Execution Price: $${orderResult.executionPrice}
- Size: ${orderResult.executedSize}
- Fee: $${orderResult.fee}

OB Details:
- OB ID: ${selectedOB.$id}
- Type: ${selectedOB.type}
- Range: $${selectedOB.bottom} - $${selectedOB.top}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Action Required:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Verify position on Hyperliquid
2. Manually update database if needed
3. Check system logs
4. Ensure database connection is stable

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    await transporter.sendMail({
      from: `"OB Trading Bot ALERT" <${config.emailConfig.auth.user}>`,
      to: config.emailRecipient,
      subject: subject,
      text: body,
      priority: "high"
    });

    log(`   ✅ Emergency alert sent`);
  } catch (emailErr) {
    log(`   ❌ Failed to send emergency alert: ${emailErr.message}`);
  }
}