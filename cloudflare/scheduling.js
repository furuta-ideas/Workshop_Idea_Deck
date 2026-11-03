// Frequent browser polls must not keep pushing an already due alarm forward.
export async function scheduleAlarm(storage, dueAt, now = Date.now()) {
  const target = Math.max(now + 1000, dueAt);
  const existing = await storage.getAlarm();
  if (existing === null || target < existing) await storage.setAlarm(target);
}
