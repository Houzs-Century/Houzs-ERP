export function isSetupDismantleJob(row: {
  dp_job_type?: string | null;
}): boolean {
  const t = (row.dp_job_type || "").trim().toUpperCase();
  return t === "SETUP" || t === "DISMANTLE";
}
