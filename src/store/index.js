import { MemoryStore } from './memory.js';

/** Mongo if MONGODB_URI is set, otherwise in-memory. */
export async function createStore(config) {
  if (config.mongoUri) {
    const { MongoStore } = await import('./mongo.js');
    const store = new MongoStore({ uri: config.mongoUri, logRetentionDays: config.logRetentionDays });
    await store.connect();
    return store;
  }
  return new MemoryStore();
}
