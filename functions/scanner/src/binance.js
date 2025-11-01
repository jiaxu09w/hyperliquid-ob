/**
 * Binance API 封装（修复版）
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
      // ✅ 清理参数（移除可能的空格和特殊字符）
      const cleanSymbol = symbol.trim().toUpperCase();
      const cleanInterval = interval.trim().toLowerCase();
      const cleanLimit = Math.min(Math.max(1, parseInt(limit)), 1000);

      console.log(`[Binance] Fetching ${cleanLimit} ${cleanInterval} klines for ${cleanSymbol}...`);

      const response = await axios.get(`${this.baseURL}/klines`, {
        params: { 
          symbol: cleanSymbol, 
          interval: cleanInterval, 
          limit: cleanLimit 
        },
        timeout: this.timeout
      });

      if (!response.data || response.data.length === 0) {
        throw new Error('No data returned from Binance');
      }

      return this._parseKlines(response.data);
    } catch (err) {
      // ✅ 详细错误信息
      if (err.response) {
        console.error(`[Binance] API error: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        throw new Error(`Binance API error: ${err.response.data.msg || err.message}`);
      }
      console.error(`[Binance] Network error: ${err.message}`);
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

    const cleanSymbol = symbol.trim().toUpperCase();
    const cleanInterval = interval.trim().toLowerCase();

    console.log(`[Binance] Fetching historical ${cleanInterval} klines for ${cleanSymbol}...`);

    while (currentStartTime < finalEndTime) {
      try {
        const response = await axios.get(`${this.baseURL}/klines`, {
          params: {
            symbol: cleanSymbol,
            interval: cleanInterval,
            startTime: currentStartTime,
            limit
          },
          timeout: this.timeout
        });

        if (response.data.length === 0) break;

        klines.push(...response.data);
        currentStartTime = response.data[response.data.length - 1][0] + 1;

        // 避免限流
        await this._sleep(200);
      } catch (err) {
        console.error(`[Binance] API error: ${err.message}`);
        
        if (err.response?.status === 429) {
          console.log('[Binance] Rate limited, waiting 60s...');
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
      console.error('[Binance] Failed to get server time:', err.message);
      return Date.now();
    }
  }

  /**
   * 获取交易对信息
   */
  async getSymbolInfo(symbol) {
    try {
      const cleanSymbol = symbol.trim().toUpperCase();
      
      const response = await axios.get(`${this.baseURL}/exchangeInfo`, {
        params: { symbol: cleanSymbol },
        timeout: 5000
      });
      
      if (!response.data.symbols || response.data.symbols.length === 0) {
        throw new Error(`Symbol ${cleanSymbol} not found`);
      }
      
      return response.data.symbols[0];
    } catch (err) {
      console.error('[Binance] Failed to get symbol info:', err.message);
      return null;
    }
  }
}

module.exports = BinanceAPI;