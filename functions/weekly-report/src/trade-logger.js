/**
 * 交易记录系统
 * 用于记录所有交易活动，生成报告
 */

const { COLLECTIONS } = require('./constants');

/**
 * 记录交易事件
 */
async function logTradeEvent(databases, databaseId, eventData) {
  const { ID } = require('node-appwrite');
  
  try {
    await databases.createDocument(
      databaseId,
      COLLECTIONS.TRADE_LOGS,
      ID.unique(),
      {
        timestamp: new Date().toISOString(),
        eventType: eventData.eventType,  // 'OPEN', 'ADD', 'CLOSE'
        symbol: eventData.symbol,
        side: eventData.side,
        
        // 交易详情
        price: eventData.price,
        size: eventData.size,
        fee: eventData.fee || 0,
        
        // 持仓信息
        positionId: eventData.positionId,
        avgEntryPrice: eventData.avgEntryPrice,
        totalSize: eventData.totalSize,
        
        // 盈亏（仅平仓时）
        pnl: eventData.pnl || 0,
        pnlPercent: eventData.pnlPercent || 0,
        exitReason: eventData.exitReason || null,
        
        // OB 信息
        obId: eventData.obId,
        obType: eventData.obType,
        obConfidence: eventData.obConfidence,
        
        // 策略信息
        strategy: eventData.strategy || 'ob_breakout',
        orderStrategy: eventData.orderStrategy,  // 'market' or 'limit'
        
        // 元数据
        metadata: JSON.stringify({
          balance: eventData.balance,
          leverage: eventData.leverage,
          stopLoss: eventData.stopLoss,
          liquidationPrice: eventData.liquidationPrice,
          deviation: eventData.deviation,
          obAge: eventData.obAge
        })
      }
    );
    
    return { success: true };
  } catch (err) {
    console.error('Failed to log trade event:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 获取交易统计
 */
async function getTradeStats(databases, databaseId, startDate, endDate) {
  const { Query } = require('node-appwrite');
  
  try {
    const trades = await databases.listDocuments(
      databaseId,
      COLLECTIONS.TRADE_LOGS,
      [
        Query.greaterThanEqual('timestamp', startDate.toISOString()),
        Query.lessThanEqual('timestamp', endDate.toISOString()),
        Query.limit(1000)
      ]
    );

    const stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      totalPnL: 0,
      totalFees: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      winRate: 0,
      profitFactor: 0,
      trades: []
    };

    let winPnL = 0;
    let lossPnL = 0;

    for (const trade of trades.documents) {
      if (trade.eventType === 'CLOSE') {
        stats.totalTrades++;
        stats.totalPnL += trade.pnl;
        stats.totalFees += trade.fee;

        if (trade.pnl > 0) {
          stats.wins++;
          winPnL += trade.pnl;
          if (trade.pnl > stats.largestWin) stats.largestWin = trade.pnl;
        } else if (trade.pnl < 0) {
          stats.losses++;
          lossPnL += Math.abs(trade.pnl);
          if (trade.pnl < stats.largestLoss) stats.largestLoss = trade.pnl;
        } else {
          stats.breakeven++;
        }

        stats.trades.push(trade);
      }
    }

    stats.avgWin = stats.wins > 0 ? winPnL / stats.wins : 0;
    stats.avgLoss = stats.losses > 0 ? lossPnL / stats.losses : 0;
    stats.winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0;
    stats.profitFactor = lossPnL > 0 ? winPnL / lossPnL : 0;

    return stats;
  } catch (err) {
    console.error('Failed to get trade stats:', err.message);
    return null;
  }
}

module.exports = {
  logTradeEvent,
  getTradeStats
};