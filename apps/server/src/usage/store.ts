import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { UsagePrice, UsageRecord } from '@agentdeck/shared/usage';
import { inspectDirectory, assertDirectoryUnchanged } from '../platform/files/safe-file';

/** 只保存计量投影；原生正文始终留在CLI自己的存储。 */
export function createUsageStore(configDir: string) {
  async function access<T>(action: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    const directories = await inspectDirectory(configDir, true);
    const file = path.join(configDir, 'usage.sqlite');
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (entry && (entry.isSymbolicLink() || !entry.isFile())) throw new Error('用量索引路径不可用。');
    await assertDirectoryUnchanged(directories!);
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS records(source TEXT NOT NULL,id TEXT NOT NULL,time INTEGER NOT NULL,project TEXT NOT NULL,directory TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source,id));
        CREATE INDEX IF NOT EXISTS usage_time ON records(time,source,id);
        CREATE INDEX IF NOT EXISTS usage_identity ON records(id,source);
        CREATE TABLE IF NOT EXISTS staging(batch TEXT NOT NULL,source TEXT NOT NULL,id TEXT NOT NULL,time INTEGER NOT NULL,project TEXT NOT NULL,directory TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(batch,source,id));
        CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      return await action(db);
    } finally {
      db.close();
    }
  }
  return {
    stage(scope: { batch: string; source: string; directory: string }, rows: UsageRecord[], complete: boolean) {
      const { batch, source, directory } = scope;
      return access((db) => {
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM staging WHERE source=? AND batch<>?').run(source, batch);
          const insert = db.prepare('INSERT OR REPLACE INTO staging VALUES(?,?,?,?,?,?,?)');
          for (const row of rows)
            insert.run(batch, source, row.id, row.timestamp, row.projectId, directory, JSON.stringify(row));
          let count = 0;
          if (complete) {
            db.prepare('DELETE FROM records WHERE source=?').run(source);
            count = Number(
              db
                .prepare(
                  'INSERT INTO records SELECT source,id,time,project,directory,payload FROM staging WHERE batch=? AND source=?',
                )
                .run(batch, source).changes,
            );
            db.prepare('DELETE FROM staging WHERE batch=? AND source=?').run(batch, source);
          }
          db.exec('COMMIT');
          return count;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
    },
    discard(batch: string, source: string) {
      return access((db) => {
        db.prepare('DELETE FROM staging WHERE batch=? AND source=?').run(batch, source);
      });
    },
    scan<T>(
      query: { from: number; to: number; projects: Map<string, string>; signal?: AbortSignal },
      consume: (rows: AsyncIterable<UsageRecord>) => Promise<T>,
    ) {
      return access(async (db) => {
        const { from, to, projects, signal } = query;
        const scope = (alias: string) =>
          [...projects].map(() => `(${alias}.project=? AND ${alias}.directory=?)`).join(' OR ');
        async function* records() {
          if (!projects.size) return;
          let cursor: [number, string, string] | undefined;
          for (;;) {
            signal?.throwIfAborted();
            const after = cursor ? 'AND (r.time,r.source,r.id)<(?,?,?)' : '';
            const rows = db
              .prepare(
                `SELECT r.payload,r.time,r.source,r.id FROM records r WHERE r.time>=? AND r.time<? AND (${scope('r')}) ${after}
              AND NOT EXISTS(SELECT 1 FROM records d WHERE d.id=r.id AND d.source<r.source AND d.time>=? AND d.time<? AND (${scope('d')}))
              ORDER BY r.time DESC,r.source DESC,r.id DESC LIMIT 500`,
              )
              .all(from, to, ...[...projects].flat(), ...(cursor ?? []), from, to, ...[...projects].flat());
            for (const row of rows) yield JSON.parse(String(row.payload)) as UsageRecord;
            const last = rows.at(-1);
            if (rows.length < 500 || !last) return;
            cursor = [Number(last.time), String(last.source), String(last.id)];
            await setImmediate(undefined, { signal });
          }
        }
        db.exec('BEGIN');
        try {
          return await consume(records());
        } finally {
          db.exec('ROLLBACK');
        }
      });
    },
    prices() {
      return access(
        (db) =>
          JSON.parse(
            String(db.prepare("SELECT value FROM preferences WHERE key='prices'").get()?.value ?? '[]'),
          ) as UsagePrice[],
      );
    },
    savePrices(this: void, prices: UsagePrice[]) {
      return access((db) => {
        db.prepare("INSERT OR REPLACE INTO preferences VALUES('prices',?)").run(JSON.stringify(prices));
      });
    },
    lastSync() {
      return access(
        (db) => Number(db.prepare("SELECT value FROM preferences WHERE key='lastSync'").get()?.value) || undefined,
      );
    },
    synced() {
      return access((db) => {
        db.prepare("INSERT OR REPLACE INTO preferences VALUES('lastSync',?)").run(String(Date.now()));
      });
    },
  };
}
