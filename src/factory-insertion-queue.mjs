// A timed position is a fence. Only a full output lets later jobs pass.
export function nextInsertionIndex(jobs, now, isFull, canMake) {
  for (const [index, job] of jobs.entries()) {
    if (job.at > now) break;
    if (!isFull(job.id) && (index === 0 || canMake(job.id))) return index;
  }
  return -1;
}

export function insertionYieldsToProduction(entry, now, isFull, canMake) {
  if (!entry) return true;
  if (entry.flight || entry.remove?.length || !entry.jobs?.length || entry.jobs[0].at > now) return false;
  return nextInsertionIndex(entry.jobs, now, isFull, canMake) < 0;
}

// Legacy journals contain one row per unit. New batches keep their remaining count.
export function consumeInsertionUnit(jobs, index) {
  const job = jobs[index];
  if (job.quantity > 1) jobs[index] = { ...job, quantity:job.quantity - 1 };
  else jobs.splice(index, 1);
}
