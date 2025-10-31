const axios = require('axios');

class BinanceAPI {
  constructor() {
    this.baseURL = 'https://api.binance.com/api/v3';
  }

  /**
   * 获取最近的 K 线数据
   */
  async getRecentKlines(symbol, interval, limit = 100) {
    try {
      const response = await axios.get(`${this.baseURL}/klines`, {
        params: { symbol, interval, limit },
        timeout: 10000
      });

      return response.data.map((k, index) => ({
        timestamp: new Date(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        index
      }));
    } catch (err) {
      console.error('Binance API error:', err.message);
      throw err;
    }
  }

  /**
   * 获取历史 K 线数据（分页）
   */
  async getHistoricalKlines(symbol, interval, startTime, endTime) {
    const klines = [];
    let currentStartTime = new Date(startTime).getTime();
    const finalEndTime = new Date(endTime).getTime();

    while (currentStartTime < finalEndTime) {
      try {
        const response = await axios.get(`${this.baseURL}/klines`, {
          params: {
            symbol,
            interval,
            startTime: currentStartTime,
            limit: 1000
          },
          timeout: 10000
        });

        if (response.data.length === 0) break;

        klines.push(...response.data);
        currentStartTime = response.data[response.data.length - 1][0] + 1;

        // 避免触发限流
        await this.sleep(200);
      } catch (err) {
        console.error('Binance API error:', err.message);
        break;
      }
    }

    return klines.map((k, index) => ({
      timestamp: new Date(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      index
    }));
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = BinanceAPI;