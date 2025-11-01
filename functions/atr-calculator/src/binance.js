/**
 * Binance API 封装（增强错误处理）
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
      // ✅ 严格清理参数
      const cleanSymbol = this._cleanSymbol(symbol);
      const cleanInterval = this._cleanInterval(interval);
      const cleanLimit = this._cleanLimit(limit);

      console.log(`[Binance] Request: ${cleanSymbol} ${cleanInterval} limit=${cleanLimit}`);

      const response = await axios.get(`${this.baseURL}/klines`, {
        params: { 
          symbol: cleanSymbol, 
          interval: cleanInterval, 
          limit: cleanLimit 
        },
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.data || response.data.length === 0) {
        throw new Error('No data returned from Binance');
      }

      console.log(`[Binance] ✅ Received ${response.data.length} klines`);

      return this._parseKlines(response.data);
    } catch (err) {
      // 详细错误日志
      if (err.response) {
        console.error(`[Binance] HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
        throw new Error(`Binance API error: ${err.response.data.msg || err.response.status}`);
      } else if (err.request) {
        console.error(`[Binance] No response received:`, err.message);
        throw new Error(`Network error: ${err.message}`);
      } else {
        console.error(`[Binance] Request setup error:`, err.message);
        throw new Error(`Failed to fetch klines: ${err.message}`);
      }
    }
  }

  /**
   * 清理 symbol 参数
   */
  _cleanSymbol(symbol) {
    if (!symbol) throw new Error('Symbol is required');
    
    // 移除空格、换行、注释
    let cleaned = symbol.toString().trim();
    
    // 移除可能的注释
    if (cleaned.includes('#')) {
      cleaned = cleaned.split('#')[0].trim();
    }
    
    // 转大写
    cleaned = cleaned.toUpperCase();
    
    // 验证格式
    if (!/^[A-Z0-9]+$/.test(cleaned)) {
      throw new Error(`Invalid symbol format: ${symbol}`);
    }
    
    return cleaned;
  }

  /**
   * 清理 interval 参数
   */
  _cleanInterval(interval) {
    if (!interval) throw new Error('Interval is required');
    
    let cleaned = interval.toString().trim();
    
    if (cleaned.includes('#')) {
      cleaned = cleaned.split('#')[0].trim();
    }
    
    cleaned = cleaned.toLowerCase();
    
    // 验证是否是有效的 interval
    const validIntervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
    
    if (!validIntervals.includes(cleaned)) {
      throw new Error(`Invalid interval: ${interval}. Valid options: ${validIntervals.join(', ')}`);
    }
    
    return cleaned;
  }

  /**
   * 清理 limit 参数
   */
  _cleanLimit(limit) {
    const numLimit = parseInt(limit);
    
    if (isNaN(numLimit) || numLimit < 1) {
      throw new Error(`Invalid limit: ${limit}`);
    }
    
    // Binance 最大 1000
    return Math.min(Math.max(1, numLimit), 1000);
  }

  /**
   * 获取历史 K 线数据
   */
  async getHistoricalKlines(symbol, interval, startTime, endTime) {
    const klines = [];
    let currentStartTime = new Date(startTime).getTime();
    const finalEndTime = new Date(endTime).getTime();
    const limit = 1000;

    const cleanSymbol = this._cleanSymbol(symbol);
    const cleanInterval = this._cleanInterval(interval);

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

        await this._sleep(200);
      } catch (err) {
        console.error(`[Binance] Error: ${err.message}`);
        
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

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

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

  async getSymbolInfo(symbol) {
    try {
      const cleanSymbol = this._cleanSymbol(symbol);
      
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