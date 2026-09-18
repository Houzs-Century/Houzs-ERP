// ----------------------------------------------------------------------------
// THE OFFICE MACHINE'S OWN LOG, ON THE SCREEN THAT SHOWS THE FAILURES.
//
// `GET /api/scm/autocount-outbox/host-log` has existed since the day the outbox
// page did, and NOTHING has ever called it. That is not a tidiness problem: the
// AutoCount service asks the vendor's own validator which of the line keys it
// will accept before every partial transfer, and writes the answer to a text
// file on the shop-floor PC. Ten delivery orders spent six attempts each being
// refused with the eleven words `Invalid transfer item.`, while the sentence
// naming the offending line was produced sixty times and read none of them —
// because reading it meant a remote-desktop session onto that machine.
//
// This module is the client for that route plus the reading of it: the log is a
// wall of text and the two or three lines that answer the question are in the
// middle of it, so `acHostLogFindings` lifts those out and says what each one
// means. The classifier never invents a verdict — an unrecognised line is left
// alone and shown as itself.
//
// WHAT IT IS NOT: a fix. The durable answer is the verdict riding in the error
// the ERP stores, which is a change to AcSyncService.cs and reaches the host
// only when somebody rebuilds it. Until then this reads what is already there.
// ----------------------------------------------------------------------------
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";

/** What `GET /autocount-outbox/host-log` answers with. */
export interface AcHostLogResponse {
  ok: boolean;
  /** The file the host read, as the host names it. Null when it could not say. */
  path: string | null;
  /** False when the host answered but the log file is not there. */
  exists: boolean | null;
  lines: string[];
}

/** The default tail. The host clamps to its own MaxLogLines, so asking for more
 *  than it will give is not an error there — this is a request, not a promise. */
export const AC_HOST_LOG_LINES = 400;

export async function fetchAcHostLog(
  lines: number,
  onlyErrors: boolean,
): Promise<AcHostLogResponse> {
  const qs = `?lines=${encodeURIComponent(String(lines))}${onlyErrors ? "&onlyErrors=1" : ""}`;
  return api.get<AcHostLogResponse>(`/api/scm/autocount-outbox/host-log${qs}`);
}

/**
 * The log, on demand and NEVER on page load.
 *
 * `enabled` is the whole safety argument and it is required, not optional: this
 * is a round trip through a Cloudflare tunnel to a desktop PC in the office, and
 * a panel that fetches it whenever the Sync page opens would put that machine on
 * the critical path of a page every staff member loads. It fires when somebody
 * opens the panel and asks for it.
 */
export function useAcHostLog(lines: number, onlyErrors: boolean, enabled: boolean) {
  return useQuery<AcHostLogResponse>(
    "/api/scm/autocount-outbox/host-log",
    () => fetchAcHostLog(lines, onlyErrors),
    [lines, onlyErrors],
    { staleTime: 15_000, enabled },
  );
}

/** How loudly a recognised line should read. `answer` is the one that resolves a
 *  refusal; `bad` is a fault; `note` is context worth keeping in view. */
export type AcHostLogTone = "answer" | "bad" | "note";

export interface AcHostLogFinding {
  /** The log line, verbatim. Never rewritten — it is the machine's own words. */
  line: string;
  tone: AcHostLogTone;
  /** What it means, in the operator's terms. */
  meaning: string;
}

/* Each rule is a substring the host writes and the sentence it stands for. The
   substrings are copied from AcSyncService.cs; if one is renamed there this
   classifier silently stops matching, which is why the panel always shows the
   raw tail as well and never claims "nothing found" as a verdict. */
const RULES: ReadonlyArray<{ needle: string; tone: AcHostLogTone; meaning: string }> = [
  {
    needle: "valid-transfer-item check: AutoCount kept FEWER rows",
    tone: "answer",
    meaning:
      "AutoCount refused some of the lines this document tried to take. The shortfall IS the invalid transfer item — the line beneath this one says how many of how many survived.",
  },
  {
    needle: "valid-transfer-item check THREW",
    tone: "answer",
    meaning:
      "AutoCount's own validator refused this whole set of lines outright, before any document was created. Its words follow on the same line.",
  },
  {
    needle: "valid-transfer-item check: returned NULL",
    tone: "bad",
    meaning:
      "AutoCount's validator answered nothing at all for these lines — neither an acceptance nor a refusal.",
  },
  {
    needle: "valid-transfer-item check:",
    tone: "note",
    meaning: "AutoCount was asked which of the lines it will accept. This is its count.",
  },
  {
    needle: "WARNING: the target has NO",
    tone: "answer",
    meaning:
      "The document being built carries no customer or supplier account. On the sales side this is a PROVEN cause of `Invalid transfer item.`",
  },
  {
    needle: "before transfer = []",
    tone: "bad",
    meaning: "The account was never applied to the target — it is empty at the moment the transfer runs.",
  },
  {
    needle: "SDK EVENT",
    tone: "note",
    meaning: "AutoCount raised one of its own dialogs. Nobody was there to answer it, so it was recorded instead.",
  },
  {
    needle: " refused: ",
    tone: "bad",
    meaning: "The transfer was refused. This line carries the exception type as well as the message.",
  },
  {
    needle: "NOT FOUND in",
    tone: "answer",
    meaning: "A line key the ERP sent is on no row in the account book at all.",
  },
  {
    needle: "falling back to AddPartialTransferDetail",
    tone: "note",
    meaning:
      "The documented transfer call could not be used, so the older by-line call was used instead. The reason is in brackets.",
  },
];

/**
 * The lines worth reading, in the order the host wrote them.
 *
 * ONE finding per line — the first rule that matches wins, so the specific
 * spellings sit above the general ones in RULES. An unmatched line is not a
 * finding and is not silently dropped either: the panel renders the whole tail
 * underneath, and this list is a way in rather than a substitute for it.
 */
export function acHostLogFindings(lines: readonly string[]): AcHostLogFinding[] {
  const out: AcHostLogFinding[] = [];
  for (const line of lines) {
    const rule = RULES.find((r) => line.includes(r.needle));
    if (rule) out.push({ line, tone: rule.tone, meaning: rule.meaning });
  }
  return out;
}

/** Shown when the host answered and there was nothing in the tail to lift out.
 *  Deliberately not phrased as "everything is fine": an empty result also
 *  happens when the tail is too short to reach the failure. */
export const AC_HOST_LOG_NOTHING_LIFTED =
  "Nothing in this stretch of the log matched a known pattern. The full tail is below — ask for more lines if the failure you are chasing is older than it.";

/** The host answered, and said the log file is not there. */
export const AC_HOST_LOG_MISSING =
  "The AutoCount service answered, but it has no log file to read. It writes one as soon as it next does any work.";

/** The call never reached the office machine. */
export const AC_HOST_LOG_UNREACHABLE =
  "The office machine did not answer. That is the same tunnel every document goes through, so nothing is reaching AutoCount right now either.";

export const AC_HOST_LOG_TITLE = "What the office machine said";
export const AC_HOST_LOG_BLURB =
  "The AutoCount service keeps its own log on the office PC. When a document is refused with words that name nothing, the reason is usually here — including which line AutoCount itself would not take.";
export const AC_HOST_LOG_OPEN = "Read the log";
export const AC_HOST_LOG_BUSY = "Reading";
