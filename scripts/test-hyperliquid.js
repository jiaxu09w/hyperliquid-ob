/**
 * Hyperliquid Testnet 测试脚本
 */

const HyperliquidAPI = require('../shared/hyperliquid');
require('dotenv').config();

async function testHyperliquid() {
  console.log('🧪 Testing Hyperliquid API...\n');

  const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
  const testMode = true;  // Testnet

  if (!privateKey || !privateKey.startsWith('0x')) {
    console.error('❌ No private key found in .env');
    console.log('\nPlease set: HYPERLIQUID_PRIVATE_KEY=0x...');
    process.exit(1);
  }

  const hl = new HyperliquidAPI(privateKey, testMode);

  try {
    // 1️⃣ 测试价格获取
    console.log('1️⃣  Testing price query...');
    const btcPrice = await hl.getPrice('BTCUSDT');
    console.log(`   BTC Price: $${btcPrice.toLocaleString()}`);
    
    const ethPrice = await hl.getPrice('ETHUSDT');
    console.log(`   ETH Price: $${ethPrice.toLocaleString()}\n`);

    // 2️⃣ 测试余额查询
    console.log('2️⃣  Testing balance query...');
    const balance = await hl.getBalance();
    console.log(`   Balance: $${balance.toLocaleString()}\n`);

    if (balance < 100) {
      console.error('⚠️  Low balance! Please get test USDC from faucet:');
      console.log('   https://app.hyperliquid-testnet.xyz/faucet\n');
      return;
    }

    // 3️⃣ 测试下单（小仓位）
    console.log('3️⃣  Testing order placement (small size)...');
    
    const testSize = 0.001;  // 0.001 BTC
    const stopLoss = btcPrice * 0.98;  // 2% 止损
    
    console.log(`   Placing test order:`);
    console.log(`   - Side: LONG`);
    console.log(`   - Size: ${testSize} BTC`);
    console.log(`   - Entry: $${btcPrice.toFixed(2)}`);
    console.log(`   - Stop: $${stopLoss.toFixed(2)}\n`);

    const orderResult = await hl.placeOrderWithStopLoss({
      symbol: 'BTCUSDT',
      side: 'LONG',
      size: testSize,
      entryPrice: btcPrice,
      stopLoss
    });

    if (orderResult.success) {
      console.log('   ✅ Order successful!');
      console.log(`   - Order ID: ${orderResult.orderId}`);
      console.log(`   - Execution: $${orderResult.executionPrice.toFixed(2)}`);
      console.log(`   - Size: ${orderResult.executedSize}`);
      console.log(`   - Fee: $${orderResult.fee.toFixed(2)}`);
      console.log(`   - Stop Loss Order: ${orderResult.stopLossOrderId}\n`);

      // 4️⃣ 测试持仓查询
      console.log('4️⃣  Testing position query...');
      const position = await hl.getPosition('BTC');
      
      if (position) {
        console.log(`   ✅ Position found:`);
        console.log(`   - Size: ${position.szi}`);
        console.log(`   - Entry: $${position.entryPx}`);
        console.log(`   - Liquidation: $${position.liquidationPx}\n`);

        // 5️⃣ 测试平仓
        console.log('5️⃣  Testing position close...');
        const currentPrice = await hl.getPrice('BTCUSDT');
        
        const closeResult = await hl.closePosition({
          symbol: 'BTCUSDT',
          size: Math.abs(parseFloat(position.szi)),
          price: currentPrice
        });

        if (closeResult.success) {
          console.log('   ✅ Position closed successfully\n');
        } else {
          console.error(`   ❌ Close failed: ${closeResult.error}\n`);
        }
      }
    } else {
      console.error(`   ❌ Order failed: ${orderResult.error}\n`);
    }

    console.log('✅ All tests completed!\n');

  } catch (err) {
    console.error(`\n❌ Test failed: ${err.message}`);
    console.error(err.stack);
  }
}

testHyperliquid();