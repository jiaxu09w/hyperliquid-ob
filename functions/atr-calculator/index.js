const { ATR } = require('technicalindicators');
const AppwriteClient = require('../../shared/appwrite-client');
const BinanceAPI = require('../../shared/binance');
const CONFIG = require('../../config/config');

module.exports = async ({ req, res, log, error }) => {
  try {
    log('📈 ATR Calculator started');
    
    const appwrite = new AppwriteClient();
    const binance = new BinanceAPI();
    const symbol = CONFIG.TRADING.SYMBOL;
    const timeframe = CONFIG.STRATEGY.TIMEFRAMES.ENTRY;

    // 获取最近 100 根 K 线
    const klines = await binance.getRecentKlines(symbol, timeframe, 100);

    // 计算 ATR
    const atrValues = ATR.calculate({
      high: klines.map(k => k.high),
      low: klines.map(k => k.low),
      close: klines.map(k => k.close),
      period: CONFIG.STRATEGY.ATR_PERIOD
    });

    const latestATR = atrValues[atrValues.length - 1];

    log(`ATR (${CONFIG.STRATEGY.ATR_PERIOD}): ${latestATR.toFixed(2)}`);

    // 保存到数据库
    await appwrite.saveMarketData({
      symbol,
      indicator: 'ATR',
      timeframe,
      value: latestATR,
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      atr: latestATR,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`ATR calculator error: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};