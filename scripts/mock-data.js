module.exports = {
  mockKlines: [
    { timestamp: new Date('2025-01-01T00:00:00Z'), open: 60000, high: 60500, low: 59500, close: 60200, volume: 100 },
    { timestamp: new Date('2025-01-01T04:00:00Z'), open: 60200, high: 61000, low: 60000, close: 60800, volume: 150 },
    // ... 更多数据
  ],

  mockOB: {
    type: 'BULLISH',
    top: 60800,
    bottom: 60200,
    confirmationTime: '2025-01-01T08:00:00Z',
    confidence: 'high'
  },

  mockPosition: {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 60500,
    size: 0.1,
    stopLoss: 59000,
    leverage: 3
  }
};