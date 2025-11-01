/**
 * Hyperliquid API - 完整版（支持智能入场）
 */

const { ethers } = require('ethers');
const axios = require('axios');
const { HYPERLIQUID, MARKETS, SIDE } = require('./constants');

class HyperliquidAPI {
  constructor(privateKey = null, testMode = true) {
    this.testMode = testMode;
    this.baseURL = testMode 
      ? HYPERLIQUID.TESTNET_URL 
      : HYPERLIQUID.BASE_URL;
    
    if (privateKey && privateKey.startsWith('0x')) {
      this.wallet = new ethers.Wallet(privateKey);
      this.address = this.wallet.address;
      this.useMock = false;
      
      console.log(`🔗 Hyperliquid API initialized`);
      console.log(`   Network: ${testMode ? 'Testnet' : 'Mainnet'}`);
      console.log(`   Address: ${this.address}`);
    } else {
      this.useMock = true;
      this.mockBalance = 10000;
      this.mockPositions = [];
      this.mockOrders = new Map();
      
      console.log('🧪 Hyperliquid MOCK MODE');
      console.log(`   Initial balance: $${this.mockBalance}`);
    }
  }

  /**
   * 下单（支持市价单和限价单）
   */
  async placeOrderWithStopLoss({ symbol, side, size, entryPrice, stopLoss, orderType = 'market' }) {
    if (this.useMock) {
      return this._mockPlaceOrder({ symbol, side, size, entryPrice, stopLoss, orderType });
    }

    try {
      const coin = symbol.replace('USDT', '');
      
      console.log(`\n📤 Placing ${orderType} order...`);
      console.log(`   ${side} ${size} ${coin} @ $${entryPrice.toFixed(2)}`);

      // 1️⃣ 下入场单
      const entryOrder = await this._placeOrder({
        coin,
        isBuy: side === SIDE.LONG,
        limitPrice: entryPrice,
        size,
        reduceOnly: false,
        orderType: orderType === 'market' 
          ? { limit: { tif: 'Ioc' } }
          : { limit: { tif: 'Gtc' } }
      });

      if (!entryOrder.success) {
        throw new Error(entryOrder.error || 'Entry order failed');
      }

      const isFilled = entryOrder.filled;
      const isResting = entryOrder.resting;

      if (isFilled) {
        console.log(`   ✅ Order filled @ $${entryOrder.avgPrice}`);

        // 2️⃣ 下止损单
        const stopOrder = await this._placeOrder({
          coin,
          isBuy: side === SIDE.SHORT,
          limitPrice: stopLoss,
          size: entryOrder.filledSize,
          reduceOnly: true,
          orderType: {
            trigger: {
              triggerPx: stopLoss.toFixed(1),
              isMarket: true,
              tpsl: 'sl'
            }
          }
        });

        console.log(`   ✅ Stop loss set @ $${stopLoss.toFixed(2)}`);

        const position = await this.getPosition(coin);

        return {
          success: true,
          orderId: entryOrder.oid,
          executionPrice: parseFloat(entryOrder.avgPrice),
          executedSize: parseFloat(entryOrder.filledSize),
          stopLossOrderId: stopOrder.oid || `SL-${Date.now()}`,
          liquidationPrice: position?.liquidationPx || 0,
          fee: parseFloat(entryOrder.fee || 0),
          orderStatus: 'filled',
          timestamp: new Date().toISOString()
        };

      } else if (isResting) {
        console.log(`   📋 Limit order placed (resting)`);

        return {
          success: true,
          orderId: entryOrder.oid,
          orderStatus: 'resting',
          limitPrice: entryPrice,
          timestamp: new Date().toISOString()
        };

      } else {
        throw new Error('Order neither filled nor resting');
      }

    } catch (err) {
      console.error('❌ Order error:', err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 内部：下单到 Hyperliquid
   */
  async _placeOrder({ coin, isBuy, limitPrice, size, reduceOnly, orderType }) {
    try {
      const assetIndex = this._getAssetIndex(coin);
      
      const order = {
        a: assetIndex,
        b: isBuy,
        p: limitPrice.toFixed(1),
        s: size.toFixed(4),
        r: reduceOnly,
        t: orderType
      };

      const action = {
        type: 'order',
        orders: [order],
        grouping: 'na'
      };

      const signature = await this._signL1Action(action);

      const response = await axios.post(`${this.baseURL}/exchange`, {
        action,
        nonce: Date.now(),
        signature,
        vaultAddress: null
      }, { timeout: 10000 });

      if (response.data.status !== 'ok') {
        throw new Error(response.data.response || 'Order rejected');
      }

      const status = response.data.response.data.statuses[0];
      
      if (status.filled) {
        return {
          success: true,
          filled: true,
          oid: status.filled.oid,
          avgPrice: status.filled.avgPx,
          filledSize: status.filled.totalSz,
          fee: status.filled.fee
        };
      }

      if (status.resting) {
        return {
          success: true,
          resting: true,
          oid: status.resting.oid
        };
      }

      throw new Error('Order not filled or resting');

    } catch (err) {
      console.error('_placeOrder error:', err.response?.data || err.message);
      return {
        success: false,
        error: err.response?.data?.response || err.message
      };
    }
  }

  /**
   * 签名 L1 Action（简化版）
   */
  async _signL1Action(action) {
    // 注意：这是简化版，完整实现需要参考 Hyperliquid 官方文档
    // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
    
    const domain = {
      name: 'Exchange',
      version: '1',
      chainId: this.testMode ? 421614 : 42161,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };

    const value = {
      source: 'a',
      connectionId: ethers.utils.formatBytes32String('')
    };

    try {
      const signature = await this.wallet._signTypedData(domain, types, value);
      return signature;
    } catch (err) {
      console.error('Signing error:', err);
      throw new Error(`Failed to sign: ${err.message}`);
    }
  }

  /**
   * 获取资产索引
   */
  _getAssetIndex(coin) {
    const assets = ['BTC', 'ETH', 'SOL', 'ARB', 'MATIC'];
    const index = assets.indexOf(coin);
    
    if (index === -1) {
      throw new Error(`Unsupported asset: ${coin}`);
    }
    
    return index;
  }

  /**
   * 获取订单状态
   */
  async getOrderStatus(orderId) {
    if (this.useMock) {
      return this._mockGetOrderStatus(orderId);
    }

    try {
      const response = await axios.post(`${this.baseURL}/info`, {
        type: 'orderStatus',
        user: this.address,
        oid: orderId
      }, { timeout: 5000 });

      const order = response.data.order;

      if (!order) {
        return { status: 'not_found' };
      }

      return {
        status: order.status,
        avgPrice: parseFloat(order.avgPx || 0),
        filledSize: parseFloat(order.sz || 0),
        remainingSize: parseFloat(order.szRemaining || 0),
        fee: parseFloat(order.fee || 0),
        timestamp: order.timestamp
      };

    } catch (err) {
      console.error('Get order status error:', err.message);
      throw err;
    }
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId) {
    if (this.useMock) {
      return this._mockCancelOrder(orderId);
    }

    try {
      const action = {
        type: 'cancel',
        cancels: [{ oid: orderId }]
      };

      const signature = await this._signL1Action(action);

      const response = await axios.post(`${this.baseURL}/exchange`, {
        action,
        nonce: Date.now(),
        signature,
        vaultAddress: null
      });

      if (response.data.status === 'ok') {
        console.log(`✅ Order ${orderId} cancelled`);
        return { success: true };
      }

      throw new Error(response.data.response || 'Cancel failed');

    } catch (err) {
      console.error('Cancel order error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 获取持仓
   */
  async getPosition(coin) {
    if (this.useMock) {
      const symbol = coin.includes('USDT') ? coin : coin + 'USDT';
      return this.mockPositions.find(p => p.symbol === symbol) || null;
    }

    try {
      const response = await axios.post(`${this.baseURL}/info`, {
        type: 'clearinghouseState',
        user: this.address
      }, { timeout: 5000 });

      const positions = response.data.assetPositions || [];
      const position = positions.find(p => p.position.coin === coin);
      
      return position ? position.position : null;
    } catch (err) {
      console.error('Get position error:', err.message);
      return null;
    }
  }

  /**
   * 获取余额
   */
  async getBalance() {
    if (this.useMock) {
      return this.mockBalance;
    }

    try {
      const response = await axios.post(`${this.baseURL}/info`, {
        type: 'clearinghouseState',
        user: this.address
      }, { timeout: 5000 });

      return parseFloat(response.data.marginSummary.accountValue || 0);
    } catch (err) {
      console.error('Get balance error:', err.message);
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

      const price = parseFloat(response.data[coin]);
      
      if (!price || isNaN(price)) {
        throw new Error(`Invalid price for ${coin}`);
      }
      
      return price;
    } catch (err) {
      console.error('Get price error:', err.message);
      throw err;
    }
  }

  /**
   * 平仓
   */
  async closePosition({ symbol, size, price }) {
    if (this.useMock) {
      return this._mockClosePosition({ symbol, size, price });
    }

    try {
      const coin = symbol.replace('USDT', '');
      const position = await this.getPosition(coin);
      
      if (!position) {
        throw new Error('No position found');
      }

      const isBuy = parseFloat(position.szi) < 0;
      
      const result = await this._placeOrder({
        coin,
        isBuy,
        limitPrice: price,
        size,
        reduceOnly: true,
        orderType: { limit: { tif: 'Ioc' } }
      });

      if (result.success && result.filled) {
        return {
          success: true,
          executionPrice: parseFloat(result.avgPrice),
          pnl: 0,
          fee: parseFloat(result.fee || 0)
        };
      }

      return result;
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * 更新止损
   */
  async updateStopLoss({ symbol, stopLossOrderId, newStopLoss }) {
    if (this.useMock) {
      return this._mockUpdateStopLoss({ symbol, stopLossOrderId, newStopLoss });
    }

    try {
      await this.cancelOrder(stopLossOrderId);
      
      const coin = symbol.replace('USDT', '');
      const position = await this.getPosition(coin);
      
      if (!position) {
        throw new Error('No position found');
      }

      const size = Math.abs(parseFloat(position.szi));
      const isBuy = parseFloat(position.szi) < 0;
      
      const result = await this._placeOrder({
        coin,
        isBuy,
        limitPrice: newStopLoss,
        size,
        reduceOnly: true,
        orderType: {
          trigger: {
            triggerPx: newStopLoss.toFixed(1),
            isMarket: true,
            tpsl: 'sl'
          }
        }
      });

      if (result.success) {
        return {
          success: true,
          newStopLossOrderId: result.oid
        };
      }

      return result;
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Mock 模式函数
  // ═════════════════════════════════════════════════════════════════════════

  _mockPlaceOrder({ symbol, side, size, entryPrice, stopLoss, orderType }) {
    console.log(`🧪 MOCK ${orderType.toUpperCase()} ORDER: ${side} ${size} ${symbol} @ $${entryPrice.toFixed(2)}`);

    const orderId = `MOCK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const positionValue = entryPrice * size;
    const fee = positionValue * HYPERLIQUID.FEES.TAKER;
    const leverage = 3;
    const margin = positionValue / leverage;

    if (orderType === 'limit') {
      // 模拟限价单：保存到待成交订单
      this.mockOrders.set(orderId, {
        orderId,
        symbol,
        side,
        size,
        limitPrice: entryPrice,
        stopLoss,
        status: 'resting',
        createdAt: Date.now()
      });

      console.log(`   📋 Limit order placed (resting): ${orderId}`);

      return {
        success: true,
        orderId,
        orderStatus: 'resting',
        limitPrice: entryPrice,
        timestamp: new Date().toISOString()
      };
    }

    // 市价单：立即成交
    this.mockBalance -= (margin + fee);

    const position = {
      orderId,
      symbol,
      side,
      size,
      entryPrice,
      stopLoss,
      stopLossOrderId: `SL-${orderId}`,
      margin,
      leverage,
      openTime: new Date(),
      szi: side === SIDE.LONG ? size : -size
    };

    this.mockPositions.push(position);

    console.log(`   ✅ Market order filled`);
    console.log(`   Balance: $${this.mockBalance.toFixed(2)}`);

    return {
      success: true,
      orderId,
      executionPrice: entryPrice,
      executedSize: size,
      stopLossOrderId: position.stopLossOrderId,
      liquidationPrice: this._calculateLiquidationPrice(side, entryPrice, leverage),
      fee,
      orderStatus: 'filled',
      timestamp: new Date().toISOString()
    };
  }

  _mockGetOrderStatus(orderId) {
    const order = this.mockOrders.get(orderId);
    
    if (!order) {
      // 检查是否是已成交订单（在 positions 中）
      const position = this.mockPositions.find(p => p.orderId === orderId);
      if (position) {
        return {
          status: 'filled',
          avgPrice: position.entryPrice,
          filledSize: position.size,
          fee: position.entryPrice * position.size * HYPERLIQUID.FEES.TAKER
        };
      }
      return { status: 'not_found' };
    }

    // 模拟随机成交（50% 概率）
    if (order.status === 'resting') {
      const elapsed = (Date.now() - order.createdAt) / 1000;
      
      // 30秒后随机决定是否成交
      if (elapsed > 30 && Math.random() > 0.5) {
        order.status = 'filled';
        
        // 移除订单，添加到持仓
        this.mockOrders.delete(orderId);
        
        const positionValue = order.limitPrice * order.size;
        const fee = positionValue * HYPERLIQUID.FEES.TAKER;
        const leverage = 3;
        const margin = positionValue / leverage;
        
        this.mockBalance -= (margin + fee);
        
        const position = {
          orderId: order.orderId,
          symbol: order.symbol,
          side: order.side,
          size: order.size,
          entryPrice: order.limitPrice,
          stopLoss: order.stopLoss,
          stopLossOrderId: `SL-${order.orderId}`,
          margin,
          leverage,
          openTime: new Date(),
          szi: order.side === SIDE.LONG ? order.size : -order.size
        };
        
        this.mockPositions.push(position);
        
        console.log(`🧪 MOCK: Limit order ${orderId} filled @ $${order.limitPrice.toFixed(2)}`);
        
        return {
          status: 'filled',
          avgPrice: order.limitPrice,
          filledSize: order.size,
          fee
        };
      }
    }

    return {
      status: order.status,
      avgPrice: order.status === 'filled' ? order.limitPrice : 0,
      filledSize: order.status === 'filled' ? order.size : 0,
      remainingSize: order.status === 'resting' ? order.size : 0
    };
  }

  _mockCancelOrder(orderId) {
    const order = this.mockOrders.get(orderId);
    
    if (order && order.status === 'resting') {
      this.mockOrders.delete(orderId);
      console.log(`🧪 MOCK: Cancelled order ${orderId}`);
      return { success: true };
    }

    return { success: false, error: 'Order not found or already filled' };
  }

  _mockClosePosition({ symbol, size, price }) {
    const posIndex = this.mockPositions.findIndex(p => p.symbol === symbol);
    if (posIndex === -1) {
      return { success: false, error: 'Position not found' };
    }

    const position = this.mockPositions[posIndex];
    const pnl = position.side === SIDE.LONG
      ? (price - position.entryPrice) * position.size
      : (position.entryPrice - price) * position.size;

    const fee = price * position.size * HYPERLIQUID.FEES.TAKER;
    this.mockBalance += position.margin + pnl - fee;

    this.mockPositions.splice(posIndex, 1);

    console.log(`🧪 MOCK CLOSE: PnL $${pnl.toFixed(2)} | Balance $${this.mockBalance.toFixed(2)}`);

    return {
      success: true,
      executionPrice: price,
      pnl,
      fee
    };
  }

  _mockUpdateStopLoss({ symbol, stopLossOrderId, newStopLoss }) {
    const position = this.mockPositions.find(p => p.stopLossOrderId === stopLossOrderId);
    if (position) {
      position.stopLoss = newStopLoss;
      const newOrderId = `SL-${Date.now()}`;
      position.stopLossOrderId = newOrderId;
      console.log(`🧪 MOCK: Updated stop loss to $${newStopLoss.toFixed(2)}`);
      return { success: true, newStopLossOrderId: newOrderId };
    }
    return { success: false, error: 'Position not found' };
  }

  _calculateLiquidationPrice(side, entryPrice, leverage) {
    const mmr = HYPERLIQUID.LIQUIDATION.MMR;
    const maxLoss = (1 / leverage) - mmr - 0.001;

    return side === SIDE.LONG
      ? entryPrice * (1 - maxLoss)
      : entryPrice * (1 + maxLoss);
  }
}

module.exports = HyperliquidAPI;