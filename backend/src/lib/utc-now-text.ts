export function utcNowText(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace("T", " ");
}
