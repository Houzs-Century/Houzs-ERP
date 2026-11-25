/* When a driver uploads a photo on a run-sheet stop, a plain delivery still
   needs the explicit "Complete" tap. A PROJECT setup / dismantle stop (the fair
   / exhibition work) does not: the office wants the booth photos on the project
   the moment the crew takes them, so the stop auto-completes as soon as its
   photos are up (owner, 2026-11-25). "Completed" reuses the same POD path as the
   manual tap — it files the photos into project_phase_photos and ticks the
   Setup / Dismantle checklist row — so nothing new has to sync them.

   Only project stops auto-complete. A manual DP job, a service-case leg, and a
   delivery order keep the explicit tap (their Complete has its own meaning —
   e.g. a DP order flips to COMPLETED, a service case advances a stage). */
export function shouldAutoCompleteOnPhoto(args: {
  /** The stop's job source: "project" is the only one that auto-completes. */
  sourceType: "dp" | "project" | "assr";
  /** The stop is already completed — nothing to do. */
  completed: boolean;
  /** A request (manual Complete, or an earlier auto attempt) is in flight. */
  busy: boolean;
  /** The crew is filing a "completed with issue" report; let the manual button
   *  carry that, so the issue is not dropped. */
  issueOn: boolean;
  /** This screen already fired its one auto attempt. A second is not retried
   *  automatically (a transient failure would otherwise hammer /complete); the
   *  manual "Complete" button stays for a retry. */
  alreadyFired: boolean;
  /** The photos pass the completion gate: at least one is uploaded and none is
   *  still uploading, failed, or being restored. */
  gateOk: boolean;
}): boolean {
  return (
    args.sourceType === "project" &&
    !args.completed &&
    !args.busy &&
    !args.issueOn &&
    !args.alreadyFired &&
    args.gateOk
  );
}
