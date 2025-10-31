/**
 * Binance API 封装
 */

const axios = require('axios');
const { BINANCE } = require('./constants');

class BinanceAPI {
  constructor() {
    this.baseURL = BINANCE.BASE_URL;
    this.timeout = BINANCE.TIMEOUT;
  }

  /**
   * 获取最近的 K 线数据
   */
  async getRecentKlines(symbol, interval, limit = 100) {
    try {
      const response = await axios.get(`${this.baseURL}/klines`, {
        params: { symbol, interval, limit },
        timeout: this.timeout
      });

      return this._parseKlines(response.data);
    } catch (err) {
      console.error(`Binance API error: ${err.message}`);
      throw new Error(`Failed to fetch klines: ${err.message}`);
    }
  }

  /**
   * 获取历史 K 线数据（分页）
   */
  async getHistoricalKlines(symbol, interval, startTime, endTime) {
    const klines = [];
    let currentStartTime = new Date(startTime).getTime();
    const finalEndTime = new Date(endTime).getTime();
    const limit = 1000;

    console.log(`[Binance] Fetching historical ${interval} klines for ${symbol}...`);

    while (currentStartTime < finalEndTime) {
      try {
        const response = await axios.get(`${this.baseURL}/klines`, {
          params: {
            symbol,
            interval,
            startTime: currentStartTime,
            limit
          },
          timeout: this.timeout
        });

        if (response.data.length === 0) break;

        klines.push(...response.data);
        currentStartTime = response.data[response.data.length - 1][0] + 1;

        // 避免触发限流
        await this._sleep(200);
      } catch (err) {
        console.error(`Binance API error: ${err.message}`);
        
        // 重试逻辑
        if (err.response?.status === 429) {
          console.log('Rate limited, waiting 60s...');
          await this._sleep(60000);
          continue;
        }
        
        break;
      }
    }

    console.log(`[Binance] Fetched ${klines.length} klines`);
    return this._parseKlines(klines);
  }

  /**
   * 解析 K 线数据
   */
  _parseKlines(rawKlines) {
    return rawKlines.map((k, index) => ({
      timestamp: new Date(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: new Date(k[6]),
      quoteVolume: parseFloat(k[7]),
      trades: parseInt(k[8]),
      index
    }));
  }

  /**
   * 延迟函数
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取服务器时间
   */
  async getServerTime() {
    try {
      const response = await axios.get(`${this.baseURL}/time`, {
        timeout: 5000
      });
      return response.data.serverTime;
    } catch (err) {
      console.error('Failed to get server time:', err.message);
      return Date.now();
    }
  }

  /**
   * 获取交易对信息
   */
  async getSymbolInfo(symbol) {
    try {
      const response = await axios.get(`${this.baseURL}/exchangeInfo`, {
        timeout: 5000
      });
      
      const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
      if (!symbolInfo) {
        throw new Error(`Symbol ${symbol} not found`);
      }
      
      return symbolInfo;
    } catch (err) {
      console.error('Failed to get symbol info:', err.message);
      return null;
    }
  }
}

// ✅ 导出类
module.exports = BinanceAPI;