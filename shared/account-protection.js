/**
 * 账户保护机制
 */

const { Query } = require("node-appwrite");
const { COLLECTIONS } = require("./constants");

/**
 * 账户保护配置
 */
const PROTECTION_CONFIG = {
  // 单日最大亏损（%）
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 5,

  // 连续亏损限制
  maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 3,

  // 最大回撤（%）
  maxAccountDrawdown: parseFloat(process.env.MAX_DRAWDOWN) || 15,

  // 冷静期（连续亏损后的暂停时间，小时）
  cooldownPeriod: parseInt(process.env.COOLDOWN_PERIOD) || 24,

  // 交易时间限制
  tradingHours: {
    enabled: process.env.RESTRICT_TRADING_HOURS === "true",
    // 加密货币周末流动性低的时段（UTC）
    // 周五 22:00 - 周日 22:00 避免交易
    avoidWeekends: process.env.AVOID_WEEKENDS !== "false", // 默认启用
    // 其他低流动性时段（可选）
    blackoutHours: process.env.BLACKOUT_HOURS
      ? process.env.BLACKOUT_HOURS.split(",").map((h) => parseInt(h.trim()))
      : [],
  },

  // 单笔最大亏损限制
  maxSingleLoss: parseFloat(process.env.MAX_SINGLE_LOSS) || 3,

  // 启用保护（紧急停止开关）
  enabled: process.env.PROTECTION_ENABLED !== "false", // 默认启用
};

/**
 * 检查账户保护（主函数）
 */
async function checkAccountProtection(databases, databaseId, hl, log) {
  if (!PROTECTION_CONFIG.enabled) {
    log("   ⚠️  Account protection DISABLED");
    return { allowed: true, reason: "protection_disabled" };
  }

  log("\n🛡️  Checking account protection...");

  try {
    // 1. 检查交易时间
    const timeCheck = checkTradingHours();
    if (!timeCheck.allowed) {
      return timeCheck;
    }
    log(`   ✅ Trading hours OK`);

    // 2. 获取账户余额
    const currentBalance = await hl.getBalance();
    log(`   Current balance: $${currentBalance.toFixed(2)}`);

    // 3. 检查单日亏损
    const dailyCheck = await checkDailyLoss(
      databases,
      databaseId,
      currentBalance,
      log
    );
    if (!dailyCheck.allowed) {
      return dailyCheck;
    }
    log(
      `   ✅ Daily loss OK (${
        dailyCheck.dailyPnL > 0 ? "+" : ""
      }$${dailyCheck.dailyPnL.toFixed(2)})`
    );

    // 4. 检查连续亏损
    const streakCheck = await checkLossStreak(databases, databaseId, log);
    if (!streakCheck.allowed) {
      return streakCheck;
    }
    log(`   ✅ Loss streak OK (${streakCheck.consecutiveLosses} consecutive)`);

    // 5. 检查账户回撤
    const drawdownCheck = await checkDrawdown(
      databases,
      databaseId,
      currentBalance,
      log
    );
    if (!drawdownCheck.allowed) {
      return drawdownCheck;
    }
    log(
      `   ✅ Drawdown OK (${drawdownCheck.drawdownPercent.toFixed(
        2
      )}% from peak)`
    );

    // 6. 检查冷静期
    const cooldownCheck = await checkCooldownPeriod(databases, databaseId, log);
    if (!cooldownCheck.allowed) {
      return cooldownCheck;
    }
    log(`   ✅ Cooldown OK`);

    log("   🟢 All protection checks passed\n");

    return {
      allowed: true,
      stats: {
        balance: currentBalance,
        dailyPnL: dailyCheck.dailyPnL,
        consecutiveLosses: streakCheck.consecutiveLosses,
        drawdown: drawdownCheck.drawdownPercent,
        peak: drawdownCheck.peak,
      },
    };
  } catch (err) {
    log(`   ❌ Protection check error: ${err.message}`);
    // 安全起见，出错时不允许交易
    return {
      allowed: false,
      reason: "protection_error",
      error: err.message,
    };
  }
}

/**
 * 1. 检查交易时间
 */
function checkTradingHours() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 6 = Saturday

  // 检查周末
  if (PROTECTION_CONFIG.tradingHours.avoidWeekends) {
    // 周五 22:00 UTC 到 周日 22:00 UTC
    const isFridayNight = dayOfWeek === 5 && utcHour >= 22;
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0; // 整个周日

    if (isFridayNight || isSaturday || isSunday) {
      return {
        allowed: false,
        reason: "weekend_hours",
        message: "Avoid trading during weekend (low liquidity)",
        currentTime: now.toISOString(),
      };
    }
  }

  // 检查黑名单时段
  if (PROTECTION_CONFIG.tradingHours.blackoutHours.includes(utcHour)) {
    return {
      allowed: false,
      reason: "blackout_hours",
      message: `Hour ${utcHour}:00 UTC is in blackout period`,
      currentTime: now.toISOString(),
    };
  }

  return { allowed: true };
}

/**
 * 2. 检查单日亏损
 */
async function checkDailyLoss(databases, databaseId, currentBalance, log) {
  // 获取今日所有平仓的交易
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const todayPositions = await databases.listDocuments(
    databaseId,
    COLLECTIONS.POSITIONS,
    [
      Query.equal("status", "CLOSED"),
      Query.greaterThanEqual("exitTime", todayStart.toISOString()),
      Query.limit(100),
    ]
  );

  // 计算今日总盈亏
  const dailyPnL = todayPositions.documents.reduce((sum, pos) => {
    return sum + (pos.pnl || 0);
  }, 0);

  const dailyLossPercent = (dailyPnL / currentBalance) * 100;

  if (
    dailyPnL < 0 &&
    Math.abs(dailyLossPercent) >= PROTECTION_CONFIG.maxDailyLoss
  ) {
    return {
      allowed: false,
      reason: "daily_loss_limit",
      message: `Daily loss limit reached: ${dailyLossPercent.toFixed(2)}%`,
      dailyPnL,
      limit: PROTECTION_CONFIG.maxDailyLoss,
      tradesCount: todayPositions.documents.length,
    };
  }

  return {
    allowed: true,
    dailyPnL,
    dailyLossPercent,
    tradesCount: todayPositions.documents.length,
  };
}

/**
 * 3. 检查连续亏损
 */
async function checkLossStreak(databases, databaseId, log) {
  // 获取最近 20 笔交易
  const recentPositions = await databases.listDocuments(
    databaseId,
    COLLECTIONS.POSITIONS,
    [
      Query.equal("status", "CLOSED"),
      Query.orderDesc("exitTime"),
      Query.limit(20),
    ]
  );

  if (recentPositions.documents.length === 0) {
    return { allowed: true, consecutiveLosses: 0 };
  }

  // 计算连续亏损次数
  let consecutiveLosses = 0;
  for (const pos of recentPositions.documents) {
    if ((pos.pnl || 0) < 0) {
      consecutiveLosses++;
    } else {
      break; // 遇到盈利交易就停止
    }
  }

  if (consecutiveLosses >= PROTECTION_CONFIG.maxConsecutiveLosses) {
    return {
      allowed: false,
      reason: "consecutive_losses",
      message: `${consecutiveLosses} consecutive losses (max: ${PROTECTION_CONFIG.maxConsecutiveLosses})`,
      consecutiveLosses,
      limit: PROTECTION_CONFIG.maxConsecutiveLosses,
      recentTrades: recentPositions.documents
        .slice(0, consecutiveLosses)
        .map((p) => ({
          exitTime: p.exitTime,
          pnl: p.pnl,
          symbol: p.symbol,
          side: p.side,
        })),
    };
  }

  return { allowed: true, consecutiveLosses };
}

/**
 * 4. 检查账户回撤
 */
async function checkDrawdown(databases, databaseId, currentBalance, log) {
  // 获取账户峰值
  const peakRecord = await databases.listDocuments(
    databaseId,
    COLLECTIONS.SYSTEM_STATE,
    [Query.equal("key", "account_peak"), Query.limit(1)]
  );

  let peak = currentBalance;

  if (peakRecord.documents.length > 0) {
    const recordedPeak = peakRecord.documents[0].value;
    peak = Math.max(recordedPeak, currentBalance);

    // 更新峰值
    if (currentBalance > recordedPeak) {
      await databases.updateDocument(
        databaseId,
        COLLECTIONS.SYSTEM_STATE,
        peakRecord.documents[0].$id,
        {
          value: currentBalance,
          updatedAt: new Date().toISOString(),
        }
      );
      log(`   📈 New account peak: $${currentBalance.toFixed(2)}`);
    }
  } else {
    // 首次记录峰值
    await databases.createDocument(
      databaseId,
      COLLECTIONS.SYSTEM_STATE,
      require("node-appwrite").ID.unique(),
      {
        key: "account_peak",
        value: currentBalance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    );
    log(`   💾 Initial peak saved: $${currentBalance.toFixed(2)}`);
  }

  // 计算回撤
  const drawdown = peak - currentBalance;
  const drawdownPercent = (drawdown / peak) * 100;

  if (drawdownPercent >= PROTECTION_CONFIG.maxAccountDrawdown) {
    return {
      allowed: false,
      reason: "max_drawdown",
      message: `Drawdown ${drawdownPercent.toFixed(2)}% exceeds limit ${
        PROTECTION_CONFIG.maxAccountDrawdown
      }%`,
      drawdownPercent,
      drawdownAmount: drawdown,
      peak,
      currentBalance,
      limit: PROTECTION_CONFIG.maxAccountDrawdown,
    };
  }

  return {
    allowed: true,
    drawdownPercent,
    drawdownAmount: drawdown,
    peak,
    currentBalance,
  };
}

/**
 * 5. 检查冷静期
 */
async function checkCooldownPeriod(databases, databaseId, log) {
  // 获取最后一次触发保护的时间
  const cooldownRecord = await databases.listDocuments(
    databaseId,
    COLLECTIONS.SYSTEM_STATE,
    [Query.equal("key", "protection_cooldown"), Query.limit(1)]
  );

  if (cooldownRecord.documents.length === 0) {
    return { allowed: true };
  }

  const cooldownUntil = new Date(cooldownRecord.documents[0].value);
  const now = new Date();

  if (now < cooldownUntil) {
    const remainingHours = Math.ceil((cooldownUntil - now) / (1000 * 60 * 60));

    return {
      allowed: false,
      reason: "cooldown_period",
      message: `In cooldown period (${remainingHours}h remaining)`,
      cooldownUntil: cooldownUntil.toISOString(),
      remainingHours,
    };
  }

  // 冷静期已过，删除记录
  await databases.deleteDocument(
    databaseId,
    COLLECTIONS.SYSTEM_STATE,
    cooldownRecord.documents[0].$id
  );

  return { allowed: true };
}

/**
 * 触发冷静期（当保护机制触发时调用）
 */
async function triggerCooldown(
  databases,
  databaseId,
  reason,
  log,
  sendEmail = null
) {
  const cooldownUntil = new Date();
  cooldownUntil.setHours(
    cooldownUntil.getHours() + PROTECTION_CONFIG.cooldownPeriod
  );

  log(`🔴 Triggering cooldown until ${cooldownUntil.toISOString()}`);
  log(`   Reason: ${reason}`);

  // 检查是否已有冷静期记录
  const existing = await databases.listDocuments(
    databaseId,
    COLLECTIONS.SYSTEM_STATE,
    [Query.equal("key", "protection_cooldown"), Query.limit(1)]
  );

  if (existing.documents.length > 0) {
    await databases.updateDocument(
      databaseId,
      COLLECTIONS.SYSTEM_STATE,
      existing.documents[0].$id,
      {
        value: cooldownUntil.toISOString(),
        metadata: JSON.stringify({
          reason,
          triggeredAt: new Date().toISOString(),
        }),
        updatedAt: new Date().toISOString(),
      }
    );
  } else {
    await databases.createDocument(
      databaseId,
      COLLECTIONS.SYSTEM_STATE,
      require("node-appwrite").ID.unique(),
      {
        key: "protection_cooldown",
        value: cooldownUntil.toISOString(),
        metadata: JSON.stringify({
          reason,
          triggeredAt: new Date().toISOString(),
        }),
        createdAt: new Date().toISOString(),
      }
    );
  }

  // 发送紧急邮件（如果配置了）
  if (sendEmail && process.env.EMAIL_ENABLED === "true") {
    const subject = "🚨 Trading PAUSED - Account Protection Triggered";
    const body = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      ⚠️  ACCOUNT PROTECTION TRIGGERED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Trading has been automatically paused!

Reason: ${reason}
Cooldown until: ${cooldownUntil.toISOString()}
Duration: ${PROTECTION_CONFIG.cooldownPeriod} hours

Action required:
1. Review recent trades
2. Check market conditions
3. Verify strategy effectiveness
4. Wait for cooldown period to end

System will resume automatically after cooldown.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;

    await sendEmail({
      subject,
      body,
      priority: "high",
    });
  }
}

/**
 * 获取保护统计（用于监控面板）
 */
async function getProtectionStats(databases, databaseId) {
  const stats = {
    enabled: PROTECTION_CONFIG.enabled,
    config: PROTECTION_CONFIG,
    current: {},
  };

  try {
    // 获取峰值
    const peak = await databases.listDocuments(
      databaseId,
      COLLECTIONS.SYSTEM_STATE,
      [Query.equal("key", "account_peak"), Query.limit(1)]
    );
    stats.current.peak =
      peak.documents.length > 0 ? peak.documents[0].value : null;

    // 获取冷静期
    const cooldown = await databases.listDocuments(
      databaseId,
      COLLECTIONS.SYSTEM_STATE,
      [Query.equal("key", "protection_cooldown"), Query.limit(1)]
    );
    stats.current.cooldownUntil =
      cooldown.documents.length > 0 ? cooldown.documents[0].value : null;
  } catch (err) {
    stats.error = err.message;
  }

  return stats;
}

module.exports = {
  checkAccountProtection,
  triggerCooldown,
  getProtectionStats,
  PROTECTION_CONFIG,
};
