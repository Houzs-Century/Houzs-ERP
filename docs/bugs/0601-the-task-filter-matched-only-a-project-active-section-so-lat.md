## The Task filter matched only a project active section so later sections returned nothing [high]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-24: *"why once i click task on expo map on whole sept
to see my pending floorplan not appear at all macam no pending floorplan?
supposed when i click any task on future will appear as pending within one
month, all project need start to be prepared within one month"*. Picking a
section in the Project List **Task** chip returned an empty list for anything
except the earliest unfinished section, so the chip looked broken and the
per-section task badges never rendered.

**Root cause (traced, measured on production).** `listProjects` matched the
section filter against the project's ACTIVE section — the lowest-`sort_order`
section that still has an open task:

```sql
(SELECT s.name FROM project_checklist_sections s
  WHERE s.project_id = p.id AND EXISTS (open task in s)
  ORDER BY s.sort_order LIMIT 1) IN (?)
```

A project therefore belongs to exactly ONE section at a time, and one
unfinished early section hides every later one. Measured against the live
database for September 2026: **25** events, **24** report `CONTRACT` as their
active section (1 has no sections), and **23** have open `EXPO MAP —
COMPETITOR RESEARCH` tasks. So the Expo Map filter matched **0** rows while 23
events owed Expo Map work — the owner's exact report. Every section other than
CONTRACT was equally unreachable for that whole month.

This also silently disabled the two features built on the chip the week before:
the per-section task COUNT in the dropdown, and the per-project OVERDUE /
PENDING / DONE badges (`section_tasks_map`), which only render for rows the
filter returns.

**Fix.** Match on owing work in the picked section, which is what the chip's
label, its counts and its badges all promise:

```sql
EXISTS (SELECT 1 FROM project_checklist c
          JOIN project_checklist_sections s ON s.id = c.section_id
         WHERE c.project_id = p.id
           AND c.status NOT IN ('done','na')
           AND s.name IN (?))
```

Same predicate re-run against production returns **23** rows for September +
Expo Map, up from 0. The `__done` and `__none` sentinels, the multi-pick OR and
the bind order are untouched; `active_section_name` still drives the Stage
column, which is a different question and correctly stays "where is this event
now".

**Ref.** `fix/project-list-filter-stickiness`, 2026-08-24.
