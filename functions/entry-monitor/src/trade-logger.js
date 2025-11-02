/**
 * 交易记录系统（entry-monitor 内部版本）
 */

const { COLLECTIONS } = require('./constants');

async function logTradeEvent(databases, databaseId, eventData) {
  const { ID } = require('node-appwrite');
  
  try {
    await databases.createDocument(
      databaseId,
      COLLECTIONS.TRADE_LOGS,
      ID.unique(),
      {
        timestamp: new Date().toISOString(),
        eventType: eventData.eventType,
        symbol: eventData.symbol,
        side: eventData.side,
        
        price: eventData.price,
        size: eventData.size,
        fee: eventData.fee || 0,
        
        positionId: eventData.positionId,
        avgEntryPrice: eventData.avgEntryPrice,
        totalSize: eventData.totalSize,
        
        pnl: eventData.pnl || 0,
        pnlPercent: eventData.pnlPercent || 0,
        exitReason: eventData.exitReason || null,
        
        obId: eventData.obId,
        obType: eventData.obType,
        obConfidence: eventData.obConfidence,
        
        strategy: eventData.strategy || 'ob_breakout',
        orderStrategy: eventData.orderStrategy,
        
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
    console.error('Log trade event failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { logTradeEvent };