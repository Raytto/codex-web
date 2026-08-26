export function formatRemoteWorkerCapacity(capacity: number): string {
  return capacity === 0 ? "不限并发" : `最多 ${capacity} 个并发任务`;
}
