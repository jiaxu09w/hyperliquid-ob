require('dotenv').config();
const { Client, Databases, ID } = require('node-appwrite');
const CONFIG = require('../config/config');

async function setupDatabase() {
  const client = new Client()
    .setEndpoint(CONFIG.APPWRITE.ENDPOINT)
    .setProject(CONFIG.APPWRITE.PROJECT_ID)
    .setKey(CONFIG.APPWRITE.API_KEY);

  const databases = new Databases(client);
  const dbId = CONFIG.APPWRITE.DATABASE_ID;

  console.log('🔧 Setting up Appwrite database...\n');
  console.log(`Endpoint: ${CONFIG.APPWRITE.ENDPOINT}`);
  console.log(`Project: ${CONFIG.APPWRITE.PROJECT_ID}`);
  console.log(`Database: ${dbId}\n`);

  // ✅ 先测试连接
  try {
    console.log('Testing connection...');
    const testResult = await databases.listDocuments(
      dbId,
      'test_collection_that_does_not_exist',
      []
    );
  } catch (err) {
    if (err.code === 404) {
      console.log('✅ Connection successful (404 expected for test)\n');
    } else if (err.code === 401) {
      console.error('❌ Authentication failed. Check your APPWRITE_API_KEY\n');
      process.exit(1);
    } else {
      console.error(`❌ Connection failed: ${err.message}\n`);
      process.exit(1);
    }
  }

  try {
    // 创建 Collections
    const collections = [
      {
        id: 'order_blocks',
        name: 'Order Blocks',
        permissions: [],
        documentSecurity: false,
        attributes: [
          { type: 'string', key: 'symbol', size: 20, required: true },
          { type: 'string', key: 'timeframe', size: 10, required: true },
          { type: 'string', key: 'type', size: 10, required: true },
          { type: 'double', key: 'top', required: true },
          { type: 'double', key: 'bottom', required: true },
          { type: 'datetime', key: 'confirmationTime', required: true },
          { type: 'string', key: 'confidence', size: 10, required: false },
          { type: 'double', key: 'volume', required: false },
          { type: 'boolean', key: 'isActive', required: true, default: true },
          { type: 'boolean', key: 'isBroken', required: true, default: false },
          { type: 'boolean', key: 'isProcessed', required: true, default: false },
          { type: 'datetime', key: 'processedAt', required: false },
          { type: 'string', key: 'processedReason', size: 50, required: false },
          { type: 'datetime', key: 'brokenAt', required: false },
          { type: 'double', key: 'brokenPrice', required: false },
          { type: 'datetime', key: 'createdAt', required: true }
        ],
        indexes: [
          { key: 'symbol_idx', type: 'key', attributes: ['symbol'] },
          { key: 'active_idx', type: 'key', attributes: ['isActive'] },
          { key: 'processed_idx', type: 'key', attributes: ['isProcessed'] }
        ]
      },
      {
        id: 'positions',
        name: 'Positions',
        permissions: [],
        documentSecurity: false,
        attributes: [
          { type: 'string', key: 'symbol', size: 20, required: true },
          { type: 'string', key: 'side', size: 10, required: true },
          { type: 'double', key: 'entryPrice', required: true },
          { type: 'double', key: 'size', required: true },
          { type: 'double', key: 'stopLoss', required: true },
          { type: 'string', key: 'stopLossOrderId', size: 100, required: false },
          { type: 'double', key: 'liquidationPrice', required: true },
          { type: 'integer', key: 'leverage', required: true },
          { type: 'double', key: 'margin', required: true },
          { type: 'string', key: 'status', size: 20, required: true },
          { type: 'datetime', key: 'openTime', required: true },
          { type: 'datetime', key: 'closeTime', required: false },
          { type: 'double', key: 'exitPrice', required: false },
          { type: 'string', key: 'exitReason', size: 50, required: false },
          { type: 'double', key: 'pnl', required: false },
          { type: 'double', key: 'entryFee', required: false },
          { type: 'double', key: 'exitFee', required: false },
          { type: 'string', key: 'relatedOB', size: 100, required: false },
          { type: 'datetime', key: 'lastChecked', required: false },
          { type: 'double', key: 'lastPrice', required: false },
          { type: 'double', key: 'unrealizedPnL', required: false },
          { type: 'datetime', key: 'lastStopUpdate', required: false }
        ],
        indexes: [
          { key: 'status_idx', type: 'key', attributes: ['status'] },
          { key: 'symbol_idx', type: 'key', attributes: ['symbol'] }
        ]
      },
      {
        id: 'market_data',
        name: 'Market Data',
        permissions: [],
        documentSecurity: false,
        attributes: [
          { type: 'string', key: 'symbol', size: 20, required: true },
          { type: 'string', key: 'indicator', size: 20, required: true },
          { type: 'string', key: 'timeframe', size: 10, required: false },
          { type: 'double', key: 'value', required: true },
          { type: 'datetime', key: 'timestamp', required: true }
        ],
        indexes: [
          { key: 'symbol_indicator_idx', type: 'key', attributes: ['symbol', 'indicator'] }
        ]
      },
      {
        id: 'system_state',
        name: 'System State',
        permissions: [],
        documentSecurity: false,
        attributes: [
          { type: 'string', key: 'key', size: 50, required: true },
          { type: 'string', key: 'value', size: 1000, required: true },
          { type: 'datetime', key: 'createdAt', required: false },
          { type: 'datetime', key: 'updatedAt', required: false }
        ],
        indexes: [
          { key: 'key_idx', type: 'unique', attributes: ['key'] }
        ]
      },
      {
        id: 'system_logs',
        name: 'System Logs',
        permissions: [],
        documentSecurity: false,
        attributes: [
          { type: 'string', key: 'level', size: 20, required: true },
          { type: 'string', key: 'message', size: 500, required: true },
          { type: 'string', key: 'data', size: 5000, required: false },
          { type: 'datetime', key: 'timestamp', required: true }
        ],
        indexes: [
          { key: 'timestamp_idx', type: 'key', attributes: ['timestamp'] }
        ]
      }
    ];

    for (const collection of collections) {
      try {
        console.log(`Creating collection: ${collection.name}...`);
        
        await databases.createCollection(
          dbId,
          collection.id,
          collection.name,
          collection.permissions,
          collection.documentSecurity
        );
        
        console.log(`✅ Created collection: ${collection.name}`);

        // 等待集合创建完成
        await sleep(1000);

        // 创建属性
        for (const attr of collection.attributes) {
          try {
            if (attr.type === 'string') {
              await databases.createStringAttribute(
                dbId,
                collection.id,
                attr.key,
                attr.size,
                attr.required,
                attr.default,
                attr.array || false
              );
            } else if (attr.type === 'double') {
              await databases.createFloatAttribute(
                dbId,
                collection.id,
                attr.key,
                attr.required,
                attr.min,
                attr.max,
                attr.default,
                attr.array || false
              );
            } else if (attr.type === 'integer') {
              await databases.createIntegerAttribute(
                dbId,
                collection.id,
                attr.key,
                attr.required,
                attr.min,
                attr.max,
                attr.default,
                attr.array || false
              );
            } else if (attr.type === 'boolean') {
              await databases.createBooleanAttribute(
                dbId,
                collection.id,
                attr.key,
                attr.required,
                attr.default,
                attr.array || false
              );
            } else if (attr.type === 'datetime') {
              await databases.createDatetimeAttribute(
                dbId,
                collection.id,
                attr.key,
                attr.required,
                attr.default,
                attr.array || false
              );
            }
            
            await sleep(200); // 等待属性创建
          } catch (attrErr) {
            if (attrErr.code !== 409) {
              console.warn(`   ⚠️  Failed to create attribute ${attr.key}: ${attrErr.message}`);
            }
          }
        }

        console.log(`   ✅ Added ${collection.attributes.length} attributes`);

        // 等待所有属性创建完成
        await sleep(3000);

        // 创建索引
        for (const index of collection.indexes) {
          try {
            await databases.createIndex(
              dbId,
              collection.id,
              index.key,
              index.type,
              index.attributes
            );
            await sleep(200);
          } catch (indexErr) {
            if (indexErr.code !== 409) {
              console.warn(`   ⚠️  Failed to create index ${index.key}: ${indexErr.message}`);
            }
          }
        }

        console.log(`   ✅ Added ${collection.indexes.length} indexes\n`);

      } catch (err) {
        if (err.code === 409) {
          console.log(`   ⏭️  Collection ${collection.name} already exists\n`);
        } else {
          console.error(`   ❌ Error creating ${collection.name}: ${err.message}\n`);
        }
      }
    }

    console.log('✅ Database setup complete!');
    console.log('\nNext step: Run "npm run local" to test the setup\n');

  } catch (err) {
    console.error('❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

setupDatabase();