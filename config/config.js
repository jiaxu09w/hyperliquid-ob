require('dotenv').config();

const CONFIG = {
  // Appwrite
  APPWRITE: {
    ENDPOINT: process.env.APPWRITE_ENDPOINT,
    PROJECT_ID: process.env.APPWRITE_PROJECT_ID,
    API_KEY: process.env.APPWRITE_API_KEY,
    DATABASE_ID: process.env.APPWRITE_DATABASE_ID,
    COLLECTIONS: {
      ORDER_BLOCKS: 'order_blocks',
      POSITIONS: 'positions',
      TRADES: 'trades',
      MARKET_DATA: 'market_data',
      SYSTEM_STATE: 'system_state',
      LOGS: 'system_logs'
    }
  },

  // Hyperliquid
  HYPERLIQUID: {
    PRIVATE_KEY: process.env.HYPERLIQUID_PRIVATE_KEY,
    TESTNET: process.env.HYPERLIQUID_TESTNET === 'true',
    BASE_URL: 'https://api.hyperliquid.xyz',
    WS_URL: 'wss://api.hyperliquid.xyz/ws'
  },

  // 交易设置
  TRADING: {
    ENABLED: process.env.TRADING_ENABLED === 'true',
    SYMBOL: 'BTCUSDT',
    INITIAL_BALANCE: parseFloat(process.env.INITIAL_BALANCE) || 10000,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 3,
    RISK_PER_TRADE_PERCENT: parseFloat(process.env.RISK_PER_TRADE) || 1.5,
  },

  // 策略参数
  STRATEGY: {
    TIMEFRAMES: {
      HTF_TARGETS: ['1w', '1d'],
      ENTRY: '4h'
    },
    OB_SWING_LENGTH: 10,
    VOLUME_LOOKBACK: 20,
    VOLUME_METHOD: 'percentile',
    VOLUME_PARAM: 70,
    ATR_PERIOD: 14,
    ATR_SL_MULTIPLIER: 2.0,
    TRAILING_STOP_ATR_MULTIPLIER: 2.5,
    
    // OB 有效期
    MAX_OB_AGE_HOURS: 12,
    MAX_PRICE_DISTANCE_PERCENT: 0.05,  // 5%
    
    // 盈利管理
    TRAILING_STOP_TRIGGER_PERCENT: 5,  // 盈利5%后启动追踪止损
  },

  // 日志
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};

module.exports = CONFIG;