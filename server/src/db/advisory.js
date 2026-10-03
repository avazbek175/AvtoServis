/**
 * Transaction-scoped advisory locks for startup work.
 *
 * Why not `pg_advisory_lock()`: that is a *session* lock. It is not tied to the
 * transaction, so it stays attached to the PostgreSQL backend after the client is
 * returned to the node-postgres pool. Two things then go wrong:
 *
 *   * if the matching `pg_advisory_unlock()` never runs (a swallowed error, a
 *     reset connection), the lock is orphaned on that pooled backend and every
 *     other backend blocks on it forever;
 *   * advisory locks are re-entrant within a session, so the orphaned backend
 *     re-acquires it instantly and the lock quietly stops excluding anyone.
 *
 * Worse, `pg_advisory_lock()` blocks. Managed PostgreSQL (Supabase and similar)
 * applies a `statement_timeout`, so ordinary overlap between two cold starts
 * surfaces as `57014 canceling statement due to statement timeout` instead of
 * one instance waiting its turn.
 *
 * `pg_try_advisory_xact_lock()` avoids both problems: it is released by
 * PostgreSQL itself when the transaction ends -- COMMIT, ROLLBACK, or the
 * backend dying -- so there is nothing to leak, and because it never blocks it
 * can never hit a statement timeout. Contention is handled here by polling, and
 * a failed transaction cannot leave a lock behind for the next cold start.
 */

const DEFAULT_WAIT_MS = Number(process.env.DB_LOCK_WAIT_MS || 30000);
const DEFAULT_POLL_MS = Number(process.env.DB_LOCK_POLL_MS || 200);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` while holding a transaction-scoped advisory lock.
 *
 * The lock is taken inside an explicit transaction, so it is held for exactly as
 * long as `fn` needs and released by the server when that transaction ends.
 * While waiting, the transaction is rolled back between attempts so no connection
 * is left idle-in-transaction.
 *
 * Throws with `code = 'LOCK_BUSY'` when the lock is still held by someone else
 * after `waitMs`; the caller decides whether that is fatal (migrations) or can be
 * skipped (seeding, which another instance is already doing).
 */
async function withAdvisoryXactLock(client, lockId, fn, { waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, name = 'advisory' } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    await client.query('BEGIN');
    let acquired;
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [String(lockId)]);
      acquired = rows[0].locked === true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    if (!acquired) {
      await client.query('ROLLBACK').catch(() => {});
      if (Date.now() >= deadline) {
        const err = new Error(
          `${name} lock ${lockId} was held by another instance for more than ${waitMs}ms`
        );
        err.code = 'LOCK_BUSY';
        throw err;
      }
      await sleep(pollMs);
      continue;
    }

    try {
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // The rollback releases the lock, so a failed migration cannot block the
      // instances that start after it.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }
}

module.exports = { withAdvisoryXactLock };
