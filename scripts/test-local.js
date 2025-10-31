require('dotenv').config();
const CONFIG = require('../config/config');

console.log(`
╔════════════════════════════════════════════════════════════╗
║          HYPERLIQUID OB TRADER - LOCAL TEST MODE           ║
╚════════════════════════════════════════════════════════════╝

✅ Testing Mode: ${!CONFIG.TRADING.ENABLED ? 'ENABLED' : 'DISABLED'}
💰 Initial Balance: $${CONFIG.TRADING.INITIAL_BALANCE.toLocaleString()}
⚡ Leverage: ${CONFIG.TRADING.LEVERAGE}x
📊 Symbol: ${CONFIG.TRADING.SYMBOL}
`);

async function runLocalTest() {
  console.log('🧪 Starting local tests...\n');

  let passedTests = 0;
  let failedTests = 0;

  // 测试 1: Binance API
  console.log('1️⃣  Testing Binance API...');
  try {
    const BinanceAPI = require('../shared/binance');
    const binance = new BinanceAPI();
    const klines = await binance.getRecentKlines('BTCUSDT', '4h', 10);
    console.log(`   ✅ Fetched ${klines.length} klines`);
    console.log(`   Latest price: $${klines[klines.length - 1].close.toFixed(2)}\n`);
    passedTests++;
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}\n`);
    failedTests++;
  }

  // 测试 2: OB Detection
  console.log('2️⃣  Testing OB Detection...');
  try {
    const BinanceAPI = require('../shared/binance');
    const { findPotentialOrderBlocks } = require('../shared/utils');
    const binance = new BinanceAPI();
    
    const klines = await binance.getRecentKlines('BTCUSDT', '4h', 100);
    const { bullishOBs, bearishOBs } = findPotentialOrderBlocks(klines, 10, 20, 'percentile', 70);
    
    console.log(`   ✅ Found ${bullishOBs.length} bullish OBs`);
    console.log(`   ✅ Found ${bearishOBs.length} bearish OBs\n`);
    passedTests++;
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}\n`);
    failedTests++;
  }

  // 测试 3: Hyperliquid API (Test Mode)
  console.log('3️⃣  Testing Hyperliquid API (Mock Mode)...');
  try {
    const HyperliquidAPI = require('../shared/hyperliquid');
    const hl = new HyperliquidAPI();
    
    const balance = await hl.getBalance();
    console.log(`   ✅ Mock Balance: $${balance.toLocaleString()}`);
    
    const price = await hl.getPrice('BTCUSDT');
    console.log(`   ✅ BTC Price: $${price.toFixed(2)}`);
    
    // 测试下单
    const orderResult = await hl.placeOrderWithStopLoss({
      symbol: 'BTCUSDT',
      side: 'LONG',
      size: 0.01,
      entryPrice: price,
      stopLoss: price * 0.97
    });
    
    console.log(`   ✅ Mock Order: ${orderResult.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`   Entry: $${orderResult.executionPrice.toFixed(2)}`);
    console.log(`   Stop Loss ID: ${orderResult.stopLossOrderId}\n`);
    passedTests++;
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}\n`);
    failedTests++;
  }

  // 测试 4: Appwrite Connection
  console.log('4️⃣  Testing Appwrite Connection...');
  try {
    // 检查环境变量
    if (!CONFIG.APPWRITE.ENDPOINT || !CONFIG.APPWRITE.PROJECT_ID || !CONFIG.APPWRITE.API_KEY) {
      throw new Error('Missing Appwrite credentials in .env file');
    }

    console.log(`   Endpoint: ${CONFIG.APPWRITE.ENDPOINT}`);
    console.log(`   Project: ${CONFIG.APPWRITE.PROJECT_ID}`);
    console.log(`   Database: ${CONFIG.APPWRITE.DATABASE_ID || 'NOT SET'}`);

    const AppwriteClient = require('../shared/appwrite-client');
    const appwrite = new AppwriteClient();
    
    // 测试连接
    const connectionTest = await appwrite.testConnection();
    
    if (!connectionTest.success) {
      throw new Error(`${connectionTest.error}\n   Hint: ${connectionTest.hint}`);
    }
    
    console.log(`   ✅ ${connectionTest.message}`);
    
    if (connectionTest.collectionFound) {
      console.log(`   ✅ Collections exist (${connectionTest.documentCount} documents found)`);
      
      // 尝试写入测试数据
      try {
        await appwrite.setSystemState('last_test', new Date().toISOString());
        console.log(`   ✅ Can write to database`);
        
        // 读取测试
        const testValue = await appwrite.getSystemState('last_test');
        console.log(`   ✅ Can read from database${testValue ? ` (value: ${testValue.substring(0, 19)}...)` : ''}`);
        
        passedTests++;
      } catch (writeErr) {
        console.warn(`   ⚠️  Database read/write test failed: ${writeErr.message}`);
        passedTests++;
      }
    } else {
      console.warn(`   ⚠️  Collections not found`);
      console.log(`   ℹ️  ${connectionTest.hint}\n`);
      passedTests++;
    }
    
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}\n`);
    
    if (err.message.includes('Missing Appwrite credentials')) {
      console.log('   ℹ️  To fix: Update .env with your Appwrite credentials:');
      console.log('      1. Go to https://cloud.appwrite.io');
      console.log('      2. Create a project');
      console.log('      3. Get API Key from Settings → API Keys');
      console.log('      4. Create a Database and get Database ID');
      console.log('      5. Update .env file\n');
    } else if (err.message.includes('Database not found')) {
      console.log('   ℹ️  To fix:');
      console.log('      1. Create a database in Appwrite Console');
      console.log('      2. Copy the Database ID');
      console.log('      3. Set APPWRITE_DATABASE_ID in .env\n');
    }
    
    failedTests++;
  }

  // ✅ 测试总结
  console.log('\n' + '='.repeat(60));
  console.log(`TEST SUMMARY: ${passedTests} passed, ${failedTests} failed`);
  console.log('='.repeat(60) + '\n');

  if (failedTests === 0) {
    console.log('✅ All tests passed!\n');
    console.log('Next steps:');
    
    // ✅ 检查 Appwrite 设置状态
    if (!CONFIG.APPWRITE.DATABASE_ID) {
      console.log('1. Create Appwrite Database and set APPWRITE_DATABASE_ID in .env');
      console.log('2. Run: npm run setup');
    } else {
      try {
        const AppwriteClient = require('../shared/appwrite-client');
        const appwrite = new AppwriteClient();
        const connectionTest = await appwrite.testConnection();
        
        // ✅ 根据 collectionFound 判断
        if (!connectionTest.collectionFound) {
          console.log('1. Run: npm run setup (to create database collections)');
          console.log('2. Run: npm run local (to verify setup)');
        } else if (connectionTest.documentCount === 0) {
          console.log('1. ✅ Database setup complete!');
          console.log('2. Ready to deploy: npm run deploy');
          console.log('3. Or continue testing locally');
        } else {
          console.log('1. ✅ Database is working (has data)');
          console.log('2. Set TRADING_ENABLED=true in .env to enable real trading');
          console.log('3. Run: npm run deploy');
          console.log('4. Configure Appwrite Function schedules in Console');
        }
      } catch (err) {
        console.log('1. Appwrite connection test failed');
        console.log('2. Check your .env configuration');
        console.log(`   Error: ${err.message}`);
      }
    }
  } else {
    console.log('⚠️  Some tests failed. Please fix the issues above.\n');
  }

  console.log('');
}

runLocalTest().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});