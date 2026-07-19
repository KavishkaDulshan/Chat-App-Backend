/**
 * Migrate users from chat-app MongoDB to auth-db MongoDB.
 * Run with: node scripts/migrate-users.js
 * Requires MONGO_URI and MONGO_AUTH_URI env vars to be set.
 */
const mongoose = require('mongoose');

const fromUri = process.env.MONGO_URI || 'mongodb://localhost:27017/chat-app';
const toUri = process.env.MONGO_AUTH_URI || 'mongodb://localhost:27017/auth-db';

async function migrate() {
  let fromConn, toConn;
  try {
    fromConn = await mongoose.createConnection(fromUri).asPromise();
    toConn = await mongoose.createConnection(toUri).asPromise();
  } catch (err) {
    console.error('Connection failed. Make sure both MongoDB instances are running.');
    console.error(`FROM: ${fromUri}`);
    console.error(`TO:   ${toUri}`);
    console.error(err.message);
    process.exit(1);
  }

  const fromDb = fromConn.db;
  const toDb = toConn.db;

  const users = await fromDb.collection('users').find({}).toArray();
  console.log(`Found ${users.length} users in source database`);

  if (users.length === 0) {
    console.log('No users to migrate.');
    await fromConn.close();
    await toConn.close();
    return;
  }

  let inserted = 0;
  for (const user of users) {
    try {
      await toDb.collection('users').replaceOne(
        { _id: user._id },
        user,
        { upsert: true }
      );
      inserted++;
    } catch (err) {
      console.error(`Failed to migrate user ${user._id}: ${err.message}`);
    }
  }

  console.log(`Migrated ${inserted}/${users.length} users successfully.`);

  await fromConn.close();
  await toConn.close();
  process.exit(0);
}

migrate();
