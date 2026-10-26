// Per-session cache: one bounded request per 40-question page, never on Home.
export function createQuestionHistory(db, userId, batchSize = 40) {
  const values = new Map(), pending = new Map(), versions = new Map();
  return {
    get: id => values.get(id),
    set(id, value) {
      if (!value) return;
      versions.set(id, (versions.get(id) || 0) + 1);
      values.set(id, value);
    },
    async load(questions, index) {
      const start = Math.floor(index / batchSize) * batchSize;
      if (pending.has(start)) return pending.get(start);
      const ids = questions.slice(start, start + batchSize).map(q => q.id);
      if (ids.every(id => values.has(id))) return;
      const before = new Map(ids.map(id => [id, versions.get(id) || 0]));
      const request = (async () => {
        try {
          const {data, error} = await db.rpc('qbank_question_history', {p_question_ids: ids});
          if (error) throw error;
          for (const row of data || []) if ((versions.get(row.question_id) || 0) === before.get(row.question_id)) values.set(row.question_id, row);
        } catch {
          // No repeated requests on every render, and unavailable is never shown as zero.
          for (const id of ids) if (!values.has(id)) values.set(id, {unavailable: true});
        }
      })();
      pending.set(start, request);
      await request;
      pending.delete(start);
    },
    userId,
  };
}
export function historyLabel(value) {
  if (!value) return '';
  if (value.unavailable) return 'History unavailable';
  return `✅ Correct × ${Number(value.correct_count) || 0} · ❌ Wrong × ${Number(value.wrong_count) || 0}`;
}
