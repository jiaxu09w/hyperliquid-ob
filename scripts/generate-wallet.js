/**
 * 生成 Hyperliquid 测试网钱包
 * 用法：node scripts/generate-wallet.js
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

async function generateWallet() {
  console.log('🔐 Generating new Ethereum wallet for Hyperliquid...\n');

  // 生成随机钱包
  const wallet = ethers.Wallet.createRandom();

  const walletInfo = {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic.phrase,
    createdAt: new Date().toISOString()
  };

  console.log('✅ Wallet generated successfully!\n');
  console.log('═══════════════════════════════════════════════════════');
  console.log('📍 Address:');
  console.log(`   ${walletInfo.address}`);
  console.log('');
  console.log('🔑 Private Key:');
  console.log(`   ${walletInfo.privateKey}`);
  console.log('');
  console.log('📝 Mnemonic (12 words):');
  console.log(`   ${walletInfo.mnemonic}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // 保存到文件（安全提示）
  const outputPath = path.join(__dirname, 'wallet-backup.json');
  
  console.log('⚠️  SECURITY WARNING:');
  console.log('   - Never share your private key or mnemonic');
  console.log('   - Store them in a secure password manager');
  console.log('   - Do NOT commit wallet-backup.json to git\n');

  const shouldSave = process.argv.includes('--save');
  
  if (shouldSave) {
    fs.writeFileSync(outputPath, JSON.stringify(walletInfo, null, 2));
    console.log(`💾 Wallet info saved to: ${outputPath}`);
    console.log('   (Added to .gitignore automatically)\n');

    // 添加到 .gitignore
    const gitignorePath = path.join(__dirname, '..', '.gitignore');
    const gitignoreContent = fs.existsSync(gitignorePath) 
      ? fs.readFileSync(gitignorePath, 'utf8') 
      : '';

    if (!gitignoreContent.includes('wallet-backup.json')) {
      fs.appendFileSync(gitignorePath, '\n# Wallet backups\nscripts/wallet-backup.json\n');
    }
  } else {
    console.log('ℹ️  To save wallet info, run: node scripts/generate-wallet.js --save\n');
  }

  // 下一步提示
  console.log('📋 Next steps:');
  console.log('   1. Copy the private key');
  console.log('   2. Visit https://app.hyperliquid-testnet.xyz/');
  console.log('   3. Connect wallet (use private key to import)');
  console.log('   4. Get test USDC from faucet');
  console.log('   5. Add to .env:');
  console.log(`      HYPERLIQUID_PRIVATE_KEY=${walletInfo.privateKey}`);
  console.log('');
}

// 验证现有私钥
async function verifyPrivateKey(privateKey) {
  try {
    const wallet = new ethers.Wallet(privateKey);
    console.log('✅ Valid private key');
    console.log(`   Address: ${wallet.address}\n`);
    return true;
  } catch (err) {
    console.error('❌ Invalid private key:', err.message);
    return false;
  }
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--verify')) {
  const key = args[args.indexOf('--verify') + 1];
  if (!key) {
    console.error('Usage: node scripts/generate-wallet.js --verify <private_key>');
    process.exit(1);
  }
  verifyPrivateKey(key);
} else if (args.includes('--help')) {
  console.log('Usage:');
  console.log('  node scripts/generate-wallet.js [--save]    Generate new wallet');
  console.log('  node scripts/generate-wallet.js --verify <key>  Verify private key');
  console.log('  node scripts/generate-wallet.js --help      Show this help');
} else {
  generateWallet();
}