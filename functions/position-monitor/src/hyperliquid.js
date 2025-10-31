/**
 * Hyperliquid API 封装（支持测试模式）
 */

const axios = require('axios');
const { HYPERLIQUID, MARKETS, SIDE } = require('./constants');

class HyperliquidAPI {
  constructor(privateKey = null, testMode = true) {
    this.baseURL = testMode ? HYPERLIQUID.TESTNET_URL : HYPERLIQUID.BASE_URL;
    this.testMode = testMode;
    this.privateKey = privateKey;

    if (testMode || !privateKey) {
      // 测试模式
      this.mockBalance = 10000;
      this.mockPositions = [];
      this.mockOrders = [];
      console.log('🧪 Hyperliquid in TEST MODE');
    } else {
      // 真实模式（需要实现钱包签名）
      console.log('⚡ Hyperliquid LIVE MODE');
    }
  }

  /**
   * 下单并设置止损
   */
  async placeOrderWithStopLoss({ symbol, side, size, entryPrice, stopLoss, takeProfit = null }) {
    if (this.testMode) {
      return this._mockPlaceOrder({ symbol, side, size, entryPrice, stopLoss, takeProfit });
    }

    try {
      // 真实 API 调用（需要签名）
      // TODO: 实现真实下单逻辑
      throw new Error('Live trading not implemented yet');
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 模拟下单
   */
  _mockPlaceOrder({ symbol, side, size, entryPrice, stopLoss, takeProfit }) {
    console.log(`🧪 MOCK ORDER: ${side} ${size} ${symbol} @ $${entryPrice.toFixed(2)}`);
    console.log(`   Stop Loss: $${stopLoss.toFixed(2)}`);
    if (takeProfit) {
      console.log(`   Take Profit: $${takeProfit.toFixed(2)}`);
    }

    const orderId = `MOCK-${Date.now()}`;
    const stopLossOrderId = `SL-${Date.now()}`;
    const takeProfitOrderId = takeProfit ? `TP-${Date.now()}` : null;

    // 计算手续费
    const positionValue = entryPrice * size;
    const fee = positionValue * HYPERLIQUID.FEES.TAKER;

    // 计算保证金（假设 3x 杠杆）
    const leverage = 3;
    const margin = positionValue / leverage;

    // 扣除保证金和手续费
    this.mockBalance -= (margin + fee);

    // 保存模拟持仓
    const position = {
      orderId,
      symbol,
      side,
      size,
      entryPrice,
      stopLoss,
      stopLossOrderId,
      takeProfitOrderId,
      margin,
      leverage,
      openTime: new Date(),
      szi: side === SIDE.LONG ? size : -size  // Hyperliquid 格式
    };

    this.mockPositions.push(position);

    return {
      success: true,
      orderId,
      executionPrice: entryPrice,
      executedSize: size,
      stopLossOrderId,
      takeProfitOrderId,
      fee,
      liquidationPrice: this.calculateLiquidationPrice(side, entryPrice, size, margin),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 更新止损
   */
  async updateStopLoss({ symbol, stopLossOrderId, newStopLoss }) {
    if (this.testMode) {
      return this._mockUpdateStopLoss({ symbol, stopLossOrderId, newStopLoss });
    }

    try {
      // 真实 API 调用
      throw new Error('Live trading not implemented yet');
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 模拟更新止损
   */
  _mockUpdateStopLoss({ symbol, stopLossOrderId, newStopLoss }) {
    console.log(`🧪 MOCK UPDATE STOP: ${stopLossOrderId} → $${newStopLoss.toFixed(2)}`);

    const position = this.mockPositions.find(p => p.stopLossOrderId === stopLossOrderId);
    if (position) {
      position.stopLoss = newStopLoss;
      const newOrderId = `SL-${Date.now()}`;
      position.stopLossOrderId = newOrderId;
      return { success: true, newStopLossOrderId: newOrderId };
    }

    return { success: false, error: 'Position not found' };
  }

  /**
   * 平仓
   */
  async closePosition({ symbol, size, price }) {
    if (this.testMode) {
      return this._mockClosePosition({ symbol, size, price });
    }

    try {
      // 真实 API 调用
      throw new Error('Live trading not implemented yet');
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 模拟平仓
   */
  _mockClosePosition({ symbol, size, price }) {
    console.log(`🧪 MOCK CLOSE: ${symbol} @ $${price.toFixed(2)}`);

    const posIndex = this.mockPositions.findIndex(p => p.symbol === symbol);
    if (posIndex === -1) {
      return { success: false, error: 'Position not found' };
    }

    const position = this.mockPositions[posIndex];

    // 计算 PnL
    const pnl = position.side === SIDE.LONG
      ? (price - position.entryPrice) * position.size
      : (position.entryPrice - price) * position.size;

    // 计算手续费
    const exitValue = price * position.size;
    const fee = exitValue * HYPERLIQUID.FEES.TAKER;

    // 返还保证金 + PnL
    this.mockBalance += position.margin + pnl - fee;

    // 移除持仓
    this.mockPositions.splice(posIndex, 1);

    console.log(`   PnL: $${pnl.toFixed(2)} | New Balance: $${this.mockBalance.toFixed(2)}`);

    return {
      success: true,
      executionPrice: price,
      pnl,
      fee
    };
  }

  /**
   * 获取持仓
   */
  async getPosition(coin) {
    if (this.testMode) {
      const symbol = coin.includes('USDT') ? coin : coin + 'USDT';
      return this.mockPositions.find(p => p.symbol === symbol) || null;
    }

    try {
      // 真实 API 调用
      const response = await axios.post(`${this.baseURL}/info`, {
        type: 'clearinghouseState',
        user: this.address
      });

      const positions = response.data.assetPositions;
      return positions.find(p => p.position.coin === coin)?.position;
    } catch (err) {
      console.error('Get position error:', err);
      return null;
    }
  }

  /**
   * 获取余额
   */
  async getBalance() {
    if (this.testMode) {
      return this.mockBalance;
    }

    try {
      const response = await axios.post(`${this.baseURL}/info`, {
        type: 'clearinghouseState',
        user: this.address
      });
      return parseFloat(response.data.marginSummary.accountValue);
    } catch (err) {
      console.error('Get balance error:', err);
      return 0;
    }
  }

  /**
   * 获取价格
   */
  async getPrice(symbol) {
    try {
      const coin = symbol.replace('USDT', '');
      const response = await axios.post(`${this.baseURL}/info`, {
        type: 'allMids'
      }, { timeout: 5000 });
      return parseFloat(response.data[coin]);
    } catch (err) {
      console.error('Get price error:', err);
      return 0;
    }
  }

  /**
   * 计算强平价格
   */
  calculateLiquidationPrice(side, entryPrice, size, margin) {
    const mmr = HYPERLIQUID.LIQUIDATION.MMR;
    const imr = margin / (size * entryPrice);
    const feeBuffer = HYPERLIQUID.FEES.TAKER * 2;
    const maxLossRate = imr - mmr - feeBuffer;

    if (side === SIDE.LONG) {
      return entryPrice * (1 - maxLossRate);
    } else {
      return entryPrice * (1 + maxLossRate);
    }
  }

  /**
   * 四舍五入到合法精度
   */
  roundToIncrement(value, increment) {
    return Math.floor(value / increment) * increment;
  }

  /**
   * 获取市场配置
   */
  getMarketConfig(symbol) {
    return MARKETS[symbol] || MARKETS.BTCUSDT;
  }
}

module.exports = HyperliquidAPI;