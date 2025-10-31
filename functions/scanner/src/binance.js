const axios = require('axios');

async function fetchKlines(symbol, interval, limit = 100) {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/klines', {
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
    throw new Error(`Binance API error: ${err.message}`);
  }
}

module.exports = { fetchKlines };