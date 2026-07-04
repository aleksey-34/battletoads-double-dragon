import { randomUUID } from 'crypto';

export type AdminSweepBacktestJobStatus = 'running' | 'done' | 'error';

export type AdminSweepBacktestJob = {
  id: string;
  status: AdminSweepBacktestJobStatus;
  createdAt: number;
  updatedAt: number;
  result?: Record<string, unknown>;
  error?: string;
};

const jobs = new Map<string, AdminSweepBacktestJob>();
const JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 40;

const pruneJobs = (): void => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size <= MAX_JOBS) {
    return;
  }
  const sorted = Array.from(jobs.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  while (jobs.size > MAX_JOBS && sorted.length > 0) {
    const [id] = sorted.shift()!;
    jobs.delete(id);
  }
};

export const startAdminSweepBacktestJob = (
  runner: () => Promise<Record<string, unknown>>,
): string => {
  pruneJobs();
  const id = randomUUID();
  const job: AdminSweepBacktestJob = {
    id,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);

  void runner()
    .then((result) => {
      const current = jobs.get(id);
      if (!current) {
        return;
      }
      current.status = 'done';
      current.result = result;
      current.updatedAt = Date.now();
    })
    .catch((error: unknown) => {
      const current = jobs.get(id);
      if (!current) {
        return;
      }
      current.status = 'error';
      current.error = error instanceof Error ? error.message : String(error);
      current.updatedAt = Date.now();
    });

  return id;
};

export const getAdminSweepBacktestJob = (jobId: string): AdminSweepBacktestJob | null => {
  const id = String(jobId || '').trim();
  if (!id) {
    return null;
  }
  return jobs.get(id) || null;
};
