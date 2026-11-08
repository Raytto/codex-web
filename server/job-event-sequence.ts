import type { DatabaseSync } from "node:sqlite";

/** Independent of retained payloads. Run before pruning any job_events rows. */
export function migrateJobEventSequence(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS job_event_sequences (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    high_water INTEGER NOT NULL CHECK(high_water>=0)
  );
  INSERT INTO job_event_sequences(job_id,high_water)
    SELECT job_id,MAX(seq) FROM job_events GROUP BY job_id
    ON CONFLICT(job_id) DO UPDATE SET high_water=MAX(high_water,excluded.high_water);
  CREATE TRIGGER IF NOT EXISTS job_event_sequence_observe AFTER INSERT ON job_events
  BEGIN
    INSERT INTO job_event_sequences(job_id,high_water) VALUES(NEW.job_id,NEW.seq)
    ON CONFLICT(job_id) DO UPDATE SET high_water=MAX(high_water,excluded.high_water);
  END;`);
}

/** Caller owns a transaction/savepoint encompassing allocation and insertion. */
export function nextJobEventSequence(db: DatabaseSync, jobId: string): number {
  return (db.prepare(`INSERT INTO job_event_sequences(job_id,high_water)
    VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?))
    ON CONFLICT(job_id) DO UPDATE SET high_water=MAX(high_water,
      (SELECT COALESCE(MAX(seq),0) FROM job_events WHERE job_id=excluded.job_id))+1
    RETURNING high_water`).get(jobId, jobId) as { high_water: number }).high_water;
}
