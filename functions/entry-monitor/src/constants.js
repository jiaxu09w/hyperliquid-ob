/**
 * 全局常量配置
 */

// Appwrite Collections
const COLLECTIONS = {
  ORDER_BLOCKS: 'order_blocks',
  POSITIONS: 'positions',
  TRADES: 'trades',
  MARKET_DATA: 'market_data',
  SYSTEM_STATE: 'system_state',
  LOGS: 'system_logs'
};

// 交易状态
const POSITION_STATUS = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  LIQUIDATED: 'LIQUIDATED'
};

// 交易方向
const SIDE = {
  LONG: 'LONG',
  SHORT: 'SHORT'
};

// OB 类型
const OB_TYPE = {
  BULLISH: 'BULLISH',
  BEARISH: 'BEARISH'
};

// 退出原因
const EXIT_REASON = {
  STOP_LOSS: 'STOP_LOSS',
  STOP_LOSS_TRIGGERED: 'STOP_LOSS_TRIGGERED',
  HTF_TARGET_1W: 'HTF_TARGET_1w',
  HTF_TARGET_1D: 'HTF_TARGET_1d',
  REVERSAL_OB: 'REVERSAL_OB',
  TRAILING_STOP: 'TRAILING_STOP',
  EMERGENCY_CLOSE: 'EMERGENCY_CLOSE',
  LIQUIDATION: 'LIQUIDATION',
  MANUAL: 'MANUAL',
  END: 'END'
};

// Binance API
const BINANCE = {
  BASE_URL: 'https://api.binance.com/api/v3',
  KLINES_ENDPOINT: '/klines',
  TIMEOUT: 10000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000
};

// Hyperliquid 配置
const HYPERLIQUID = {
  BASE_URL: 'https://api.hyperliquid.xyz',
  TESTNET_URL: 'https://api.hyperliquid-testnet.xyz',
  
  // 手续费
  FEES: {
    MAKER: -0.00020,   // -0.02%
    TAKER: 0.00035     // 0.035%
  },
  
  // 资金费率
  FUNDING: {
    INTERVAL_HOURS: 8,
    DEFAULT_RATE: 0.0001,    // 0.01%
    MAX_RATE: 0.0005         // 0.05%
  },
  
  // 滑点
  SLIPPAGE: {
    BASE_BPS: 2,             // 0.02%
    IMPACT_FACTOR: 0.0001
  },
  
  // 强平
  LIQUIDATION: {
    MMR: 0.004,              // 0.4% 维持保证金率
    BANKRUPTCY_BUFFER: 0.005
  }
};

// 市场配置
const MARKETS = {
  BTCUSDT: {
    symbol: 'BTC',
    minSize: 0.001,
    sizeIncrement: 0.0001,
    pricePrecision: 1,
    maxLeverage: 50,
    maintenanceMarginRate: 0.004,
    defaultATR: 1000           // 默认 ATR（如果无法计算）
  },
  ETHUSDT: {
    symbol: 'ETH',
    minSize: 0.01,
    sizeIncrement: 0.001,
    pricePrecision: 2,
    maxLeverage: 50,
    maintenanceMarginRate: 0.004,
    defaultATR: 50
  }
};

// 时间常量
const TIME = {
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000
};

// K 线时间框架映射
const TIMEFRAME_MS = {
  '1m': TIME.MINUTE,
  '5m': 5 * TIME.MINUTE,
  '15m': 15 * TIME.MINUTE,
  '1h': TIME.HOUR,
  '4h': 4 * TIME.HOUR,
  '1d': TIME.DAY,
  '1w': TIME.WEEK
};

module.exports = {
  COLLECTIONS,
  POSITION_STATUS,
  SIDE,
  OB_TYPE,
  EXIT_REASON,
  BINANCE,
  HYPERLIQUID,
  MARKETS,
  TIME,
  TIMEFRAME_MS
};