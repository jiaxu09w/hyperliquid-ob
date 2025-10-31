const axios = require('axios');
const ethers = require('ethers');
const CONFIG = require('../config/config');

class HyperliquidAPI {
  constructor(privateKey = null) {
    this.baseURL = CONFIG.HYPERLIQUID.BASE_URL;
    this.testMode = !CONFIG.TRADING.ENABLED;
    
    if (privateKey && !this.testMode) {
      this.wallet = new ethers.Wallet(privateKey);
      this.address = this.wallet.address;
    } else {
      // ✅ 测试模式：使用模拟账户
      this.wallet = null;
      this.address = '0x0000000000000000000000000000000000000000';
      this.mockBalance = CONFIG.TRADING.INITIAL_BALANCE;
      this.mockPositions = [];
      this.mockOrders = [];
      console.log('🧪 Hyperliquid in TEST MODE');
    }
  }

  /**
   * ✅ 下单并设置止损（支持测试模式）
   */
  async placeOrderWithStopLoss({ symbol, side, size, entryPrice, stopLoss, takeProfit }) {
    if (this.testMode) {
      return this._mockPlaceOrder({ symbol, side, size, entryPrice, stopLoss, takeProfit });
    }

    try {
      const coin = symbol.replace('USDT', '');
      const isBuy = side === 'LONG';

      // 主订单
      const mainOrder = {
        coin,
        is_buy: isBuy,
        sz: size,
        limit_px: entryPrice,
        order_type: { limit: { tif: 'Ioc' } },
        reduce_only: false
      };

      // 止损单
      const stopLossOrder = {
        coin,
        is_buy: !isBuy,
        sz: size,
        limit_px: stopLoss,
        order_type: {
          trigger: {
            trigger_px: stopLoss,
            is_market: true,
            tpsl: 'sl'
          }
        },
        reduce_only: true
      };

      const orders = [mainOrder, stopLossOrder];

      if (takeProfit) {
        orders.push({
          coin,
          is_buy: !isBuy,
          sz: size,
          limit_px: takeProfit,
          order_type: {
            trigger: {
              trigger_px: takeProfit,
              is_market: false,
              tpsl: 'tp'
            }
          },
          reduce_only: true
        });
      }

      const action = { type: 'order', orders, grouping: 'na' };
      const nonce = Date.now();
      const signature = await this.signAction(action, nonce);

      const response = await axios.post(`${this.baseURL}/exchange`, {
        action,
        nonce,
        signature
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      if (response.data.status === 'ok') {
        const fills = response.data.response.data.statuses;
        const mainFill = fills[0];

        return {
          success: true,
          orderId: mainFill.resting?.oid || 'filled',
          executionPrice: parseFloat(mainFill.filled?.avgPx || entryPrice),
          executedSize: parseFloat(mainFill.filled?.totalSz || size),
          stopLossOrderId: fills[1]?.resting?.oid,
          takeProfitOrderId: takeProfit ? fills[2]?.resting?.oid : null,
          fee: parseFloat(mainFill.filled?.fee || 0),
          liquidationPrice: this.calculateLiquidationPrice(side, entryPrice, size),
          timestamp: new Date().toISOString()
        };
      } else {
        return {
          success: false,
          error: response.data.response || 'Order failed'
        };
      }
    } catch (err) {
      console.error('Hyperliquid order error:', err.response?.data || err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 🧪 模拟下单
   */
  _mockPlaceOrder({ symbol, side, size, entryPrice, stopLoss, takeProfit }) {
    console.log(`🧪 MOCK ORDER: ${side} ${size} ${symbol} @ $${entryPrice.toFixed(2)}`);
    console.log(`   Stop Loss: $${stopLoss.toFixed(2)}`);

    const orderId = `MOCK-${Date.now()}`;
    const stopLossOrderId = `SL-${Date.now()}`;
    
    // 模拟手续费
    const fee = entryPrice * size * 0.00035;  // 0.035% taker fee
    
    // 扣除保证金和手续费
    const margin = (entryPrice * size) / CONFIG.TRADING.LEVERAGE;
    this.mockBalance -= (margin + fee);

    // 保存模拟持仓
    this.mockPositions.push({
      orderId,
      symbol,
      side,
      size,
      entryPrice,
      stopLoss,
      stopLossOrderId,
      openTime: new Date()
    });

    return {
      success: true,
      orderId,
      executionPrice: entryPrice,
      executedSize: size,
      stopLossOrderId,
      takeProfitOrderId: takeProfit ? `TP-${Date.now()}` : null,
      fee,
      liquidationPrice: this.calculateLiquidationPrice(side, entryPrice, size),
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
      await this.cancelOrder(stopLossOrderId);
      const position = await this.getPosition(symbol.replace('USDT', ''));
      
      if (!position) {
        return { success: false, error: 'No position found' };
      }

      const coin = symbol.replace('USDT', '');
      const stopLossOrder = {
        coin,
        is_buy: position.szi > 0 ? false : true,
        sz: Math.abs(position.szi),
        limit_px: newStopLoss,
        order_type: {
          trigger: {
            trigger_px: newStopLoss,
            is_market: true,
            tpsl: 'sl'
          }
        },
        reduce_only: true
      };

      const action = { type: 'order', orders: [stopLossOrder], grouping: 'na' };
      const nonce = Date.now();
      const signature = await this.signAction(action, nonce);

      const response = await axios.post(`${this.baseURL}/exchange`, {
        action, nonce, signature
      });

      return {
        success: response.data.status === 'ok',
        newStopLossOrderId: response.data.response?.data?.statuses[0]?.resting?.oid
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 🧪 模拟更新止损
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
   * 获取持仓
   */
  async getPosition(coin) {
    if (this.testMode) {
      return this.mockPositions.find(p => p.symbol === coin + 'USDT') || null;
    }

    try {
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
   * 平仓
   */
  async closePosition({ symbol, size, price }) {
    if (this.testMode) {
      return this._mockClosePosition({ symbol, size, price });
    }

    const position = await this.getPosition(symbol.replace('USDT', ''));
    if (!position) {
      return { success: false, error: 'No position' };
    }

    const action = {
      type: 'order',
      orders: [{
        coin: symbol.replace('USDT', ''),
        is_buy: position.szi < 0,
        sz: Math.abs(position.szi),
        limit_px: price,
        order_type: { limit: { tif: 'Ioc' } },
        reduce_only: true
      }],
      grouping: 'na'
    };

    const nonce = Date.now();
    const signature = await this.signAction(action, nonce);

    const response = await axios.post(`${this.baseURL}/exchange`, {
      action, nonce, signature
    });

    return {
      success: response.data.status === 'ok',
      executionPrice: price
    };
  }

  /**
   * 🧪 模拟平仓
   */
  _mockClosePosition({ symbol, size, price }) {
    console.log(`🧪 MOCK CLOSE: ${symbol} @ $${price.toFixed(2)}`);
    
    const posIndex = this.mockPositions.findIndex(p => p.symbol === symbol);
    if (posIndex !== -1) {
      const position = this.mockPositions[posIndex];
      
      // 计算 PnL
      const pnl = position.side === 'LONG'
        ? (price - position.entryPrice) * position.size
        : (position.entryPrice - price) * position.size;
      
      // 返还保证金 + PnL
      const margin = (position.entryPrice * position.size) / CONFIG.TRADING.LEVERAGE;
      const fee = price * position.size * 0.00035;
      this.mockBalance += margin + pnl - fee;
      
      // 移除持仓
      this.mockPositions.splice(posIndex, 1);
      
      console.log(`   PnL: $${pnl.toFixed(2)} | New Balance: $${this.mockBalance.toFixed(2)}`);
      
      return { success: true, executionPrice: price };
    }
    
    return { success: false, error: 'Position not found' };
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId) {
    if (this.testMode) {
      console.log(`🧪 MOCK CANCEL: ${orderId}`);
      return { success: true };
    }

    const action = { type: 'cancel', cancels: [{ oid: orderId }] };
    const nonce = Date.now();
    const signature = await this.signAction(action, nonce);

    return await axios.post(`${this.baseURL}/exchange`, {
      action, nonce, signature
    });
  }

  /**
   * 计算强平价格
   */
  calculateLiquidationPrice(side, entryPrice, size) {
    const leverage = CONFIG.TRADING.LEVERAGE;
    const mmr = 0.004;
    const imr = 1 / leverage;
    const maxLossRate = imr - mmr - 0.001;

    if (side === 'LONG') {
      return entryPrice * (1 - maxLossRate);
    } else {
      return entryPrice * (1 + maxLossRate);
    }
  }

  /**
   * EIP-712 签名
   */
  async signAction(action, nonce) {
    if (!this.wallet) {
      return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }

    // 简化实现（实际需要完整的 EIP-712 签名）
    const message = JSON.stringify(action) + nonce;
    return await this.wallet.signMessage(message);
  }
}

module.exports = HyperliquidAPI;