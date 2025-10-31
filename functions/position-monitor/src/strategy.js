/**
 * 交易策略逻辑
 */

const { SIDE, OB_TYPE } = require('./constants');

/**
 * 检查是否应该入场
 */
function shouldEnterTrade(ob, currentPrice, config) {
  // 1. 检查 OB 年龄
  const obAge = (Date.now() - new Date(ob.confirmationTime)) / (1000 * 60 * 60);
  if (obAge > config.maxOBAge) {
    return { enter: false, reason: 'OB too old' };
  }

  // 2. 检查价格距离
  const priceDistance = ob.type === OB_TYPE.BULLISH
    ? Math.abs(currentPrice - ob.top) / ob.top
    : Math.abs(currentPrice - ob.bottom) / ob.bottom;

  if (priceDistance > config.maxPriceDistance) {
    return { enter: false, reason: 'Price too far from OB' };
  }

  // 3. 检查置信度（可选）
  if (config.requireHighConfidence && ob.confidence !== 'high') {
    return { enter: false, reason: 'Low confidence OB' };
  }

  return { enter: true };
}

/**
 * 计算止损价格
 */
function calculateStopLoss(ob, atr, config) {
  const side = ob.type === OB_TYPE.BULLISH ? SIDE.LONG : SIDE.SHORT;
  
  if (side === SIDE.LONG) {
    return ob.bottom - (atr * config.atrMultiplier);
  } else {
    return ob.top + (atr * config.atrMultiplier);
  }
}

/**
 * 计算仓位大小
 */
function calculatePositionSize(balance, leverage, riskPercent, entryPrice, stopLoss) {
  const leveragedBalance = balance * leverage;
  const riskAmount = leveragedBalance * (riskPercent / 100);
  const riskDistance = Math.abs(entryPrice - stopLoss);
  
  if (riskDistance <= 0) {
    throw new Error('Invalid stop loss distance');
  }
  
  return riskAmount / riskDistance;
}

/**
 * 检查是否应该止盈
 */
function shouldTakeProfit(position, currentPrice, htfOBs, config) {
  const side = position.side;
  
  // 检查 HTF OB 目标
  for (const htfOB of htfOBs) {
    // 过滤相反方向的 OB
    if (side === SIDE.LONG && htfOB.type === OB_TYPE.BEARISH) {
      if (currentPrice >= htfOB.bottom) {
        return {
          takeProfit: true,
          reason: `HTF_TARGET_${htfOB.timeframe}`,
          targetPrice: htfOB.bottom
        };
      }
    } else if (side === SIDE.SHORT && htfOB.type === OB_TYPE.BULLISH) {
      if (currentPrice <= htfOB.top) {
        return {
          takeProfit: true,
          reason: `HTF_TARGET_${htfOB.timeframe}`,
          targetPrice: htfOB.top
        };
      }
    }
  }

  return { takeProfit: false };
}

/**
 * 检查是否应该反向平仓
 */
function shouldExitOnReversal(position, newOBs) {
  const side = position.side;
  
  for (const ob of newOBs) {
    // 检查是否是相反方向的新 OB
    const isReversal = 
      (side === SIDE.LONG && ob.type === OB_TYPE.BEARISH) ||
      (side === SIDE.SHORT && ob.type === OB_TYPE.BULLISH);
    
    if (isReversal) {
      // 检查 OB 是否是最近形成的
      const obAge = (Date.now() - new Date(ob.confirmationTime)) / (1000 * 60 * 60);
      if (obAge <= 6) {  // 6 小时内
        return {
          exit: true,
          reason: 'REVERSAL_OB',
          obId: ob.$id
        };
      }
    }
  }

  return { exit: false };
}

/**
 * 计算追踪止损
 */
function calculateTrailingStop(position, currentPrice, atr, config) {
  const side = position.side;
  
  // 计算未实现盈亏百分比
  const positionValue = position.avgEntryPrice * position.size;
  const unrealizedPnL = side === SIDE.LONG
    ? (currentPrice - position.avgEntryPrice) * position.size
    : (position.avgEntryPrice - currentPrice) * position.size;
  
  const unrealizedPnLPercent = (unrealizedPnL / positionValue) * 100;

  // 只在盈利超过阈值时启动追踪止损
  if (unrealizedPnLPercent < config.trailingStopTrigger) {
    return { update: false };
  }

  // 计算新止损价格
  const newStopLoss = side === SIDE.LONG
    ? currentPrice - (atr * config.trailingStopMultiplier)
    : currentPrice + (atr * config.trailingStopMultiplier);

  // 检查新止损是否更有利
  const shouldUpdate = side === SIDE.LONG
    ? newStopLoss > position.stopLoss
    : newStopLoss < position.stopLoss;

  if (shouldUpdate) {
    return {
      update: true,
      newStopLoss,
      reason: 'TRAILING_STOP'
    };
  }

  return { update: false };
}

/**
 * 检查是否应该加仓
 */
function shouldAddToPosition(position, newOB, currentPrice, config) {
  // 1. 检查加仓次数
  if (position.additionCount >= config.maxAdditions) {
    return { add: false, reason: 'Max additions reached' };
  }

  // 2. 检查方向一致
  const isCorrectDirection = 
    (position.side === SIDE.LONG && newOB.type === OB_TYPE.BULLISH) ||
    (position.side === SIDE.SHORT && newOB.type === OB_TYPE.BEARISH);

  if (!isCorrectDirection) {
    return { add: false, reason: 'Wrong direction' };
  }

  // 3. 检查 OB 位置更有利
  if (position.lastOBReference) {
    const isBetterOB = position.side === SIDE.LONG
      ? newOB.bottom > position.lastOBReference.bottom
      : newOB.top < position.lastOBReference.top;

    if (!isBetterOB) {
      return { add: false, reason: 'OB not better than previous' };
    }
  }

  // 4. 检查盈利百分比
  const positionValue = position.avgEntryPrice * position.size;
  const unrealizedPnL = position.side === SIDE.LONG
    ? (currentPrice - position.avgEntryPrice) * position.size
    : (position.avgEntryPrice - currentPrice) * position.size;
  
  const unrealizedPnLPercent = (unrealizedPnL / positionValue) * 100;

  if (unrealizedPnLPercent < config.minProfitForAddition) {
    return { add: false, reason: 'Not enough profit' };
  }

  return { add: true };
}

/**
 * 计算加仓大小
 */
function calculateAdditionSize(position, balance, config) {
  // 使用缩减因子
  const scaleFactor = Math.pow(config.scaleDownFactor, position.additionCount + 1);
  const baseRisk = balance * (config.riskPerTrade / 100);
  const additionRisk = baseRisk * scaleFactor;
  
  return additionRisk;
}

/**
 * 检查强平风险
 */
function checkLiquidationRisk(position, currentPrice, config) {
  const threshold = config.liquidationThreshold || 0.05; // 5% 距离强平价
  
  const isNearLiquidation = position.side === SIDE.LONG
    ? currentPrice <= position.liquidationPrice * (1 + threshold)
    : currentPrice >= position.liquidationPrice * (1 - threshold);

  if (isNearLiquidation) {
    return {
      dangerous: true,
      distance: Math.abs((currentPrice - position.liquidationPrice) / position.liquidationPrice) * 100,
      recommendation: 'EMERGENCY_CLOSE'
    };
  }

  return { dangerous: false };
}

module.exports = {
  shouldEnterTrade,
  calculateStopLoss,
  calculatePositionSize,
  shouldTakeProfit,
  shouldExitOnReversal,
  calculateTrailingStop,
  shouldAddToPosition,
  calculateAdditionSize,
  checkLiquidationRisk
};