import type { Env } from "../types";

export type LogStatus = "SYNCED" | "FAILED" | "SKIPPED";

export async function writeLog(
  env: Env,
  args: {
    requestId: string;
    type: string;
    startedAt: Date;
    endedAt?: Date;
    status: LogStatus;
    message?: string;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO execution_logs (request_id, type, started_at, ended_at, status, message)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      args.requestId,
      args.type,
      args.startedAt.toISOString(),
      (args.endedAt ?? new Date()).toISOString(),
      args.status,
      args.message ?? null
    )
    .run();
}
