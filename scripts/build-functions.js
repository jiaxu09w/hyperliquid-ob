#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🔨 Building Appwrite Functions...\n');

// 定义每个 Function 需要的共享文件
const FUNCTION_DEPENDENCIES = {
  'scanner': ['binance.js', 'ob-detector.js', 'constants.js'],
  'entry-monitor': ['hyperliquid.js', 'strategy.js', 'constants.js', 'binance.js'],
  'position-monitor': ['hyperliquid.js', 'strategy.js', 'constants.js'],
  'atr-calculator': ['binance.js', 'constants.js']
};

const SHARED_DIR = path.join(__dirname, '..', 'shared');
const FUNCTIONS_DIR = path.join(__dirname, '..', 'functions');

// 复制文件
function copyFile(source, destination) {
  try {
    fs.copyFileSync(source, destination);
    return true;
  } catch (err) {
    console.error(`   ❌ Failed to copy ${path.basename(source)}: ${err.message}`);
    return false;
  }
}

// 处理每个 Function
for (const [functionName, dependencies] of Object.entries(FUNCTION_DEPENDENCIES)) {
  console.log(`📦 Building ${functionName}...`);
  
  const functionSrcDir = path.join(FUNCTIONS_DIR, functionName, 'src');
  
  // 确保 src 目录存在
  if (!fs.existsSync(functionSrcDir)) {
    fs.mkdirSync(functionSrcDir, { recursive: true });
  }
  
  let copiedCount = 0;
  
  for (const dep of dependencies) {
    const sourcePath = path.join(SHARED_DIR, dep);
    const destPath = path.join(functionSrcDir, dep);
    
    if (!fs.existsSync(sourcePath)) {
      console.error(`   ⚠️  Source file not found: ${dep}`);
      continue;
    }
    
    if (copyFile(sourcePath, destPath)) {
      copiedCount++;
      console.log(`   ✅ ${dep}`);
    }
  }
  
  console.log(`   Copied ${copiedCount}/${dependencies.length} files\n`);
}

console.log('✅ Build complete!\n');
console.log('Next steps:');
console.log('1. git add functions/');
console.log('2. git commit -m "build: update function dependencies"');
console.log('3. git push origin main');
console.log('');