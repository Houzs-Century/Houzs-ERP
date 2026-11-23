# Meetings

Meeting rooms shared by every company and every ERP (Houzs, Hookka, Theconts, Carres).
The data lives in the Houzs IT Hub (`houzs-hub` `routes/sysMeetings.ts`); this ERP only
relays (`backend/src/routes/meetings.ts`) and draws (`frontend/src/pages/Meetings/`).

## Who can do what
- Every signed-in staff user: see the calendar, book, invite anyone in the staff list of
  any company, make guest links.
- `meetings.manage_rooms`: add and change rooms (seats, location, hours, rules, closed
  dates) and see the Change log. Checked in the router and sent as `X-Can-Manage-Rooms`.
- Only the organiser, or whoever booked on their behalf, can move, change, start, end or
  cancel a meeting (the hub refuses others with 403).
- Guests (no login) at `/book/:code`: free times only, never who booked; confirmed at once.

## Booking rules (all enforced by the hub)
- A person already in a meeting at that time cannot be booked: 409 with who and when, plus
  the next time everyone is free. The system never drops a person; the organiser removes them.
- A room already booked, or inside its gap between meetings, cannot be booked: 409 with
  other free rooms that fit everyone and the next free time.
- Room rules: closed dates, longest booking, how far ahead. Outside a room's usual hours is
  allowed (overtime) and counted as after hours, not in the occupancy percentage.
- Occupancy = hours booked inside usual hours / usual hours that week.
- A meeting starts and ends by the clock; Start and End are optional. End early frees the room.
- Running over: nothing happens; the organiser edits the end time.
- Repeats: daily, weekdays, weekly, every 4 weeks, until a date (at most 120). Clashing
  occurrences are skipped and counted. Changing or cancelling asks "this" or "this and following".

## Identity and directory
- A person is their email in lower case, else `<hub system>:<user id>`, so one person in two
  ERPs is one calendar. The hub key follows the active company (`IT_HUB_API_KEY_<code>`).
- `services/meetingsDirectory.ts` sends every active user with company name and Org Chart
  department once an hour (cron, job `meetings-directory`). A user with no company grant is
  sent with every company.

## Gotchas
- The 409 body is relayed unchanged; the page builds the conflict dialog from it
  (`lib/meetings.ts` `readConflict`). A hub 401 becomes 502, never 401.
- Not connected (no `IT_HUB_URL` or key) = 501, and the menu row is hidden with IT Support's.
- Notifications are ERP-only until Gmail and WhatsApp are connected (tasks/TODO.md).
  Video links are pasted; automatic Meet/Zoom links come with the Google setup.
