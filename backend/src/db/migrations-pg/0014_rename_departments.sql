-- Rename departments to the owner's canonical labels (2026-06-14).
-- Idempotent: matches on the old name, so re-running is a no-op once renamed.
-- ('Management' stays as-is per the owner's list.)
UPDATE departments SET name = 'Sales Department'     WHERE name = 'Sales';
UPDATE departments SET name = 'Operation Department' WHERE name = 'Operation';
UPDATE departments SET name = 'IT Department'        WHERE name = 'Information Technology';
