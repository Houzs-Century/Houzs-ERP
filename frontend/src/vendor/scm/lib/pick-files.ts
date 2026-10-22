/* The files a <input type="file"> change hands over, read BEFORE the input is
   reset so the same file can be picked again. The order matters: resetting
   `value` empties the FileList, and a React state updater that reads
   `e.target.files` lazily runs AFTER the handler when the component has other
   work pending (react-query refetches, the version check) — then it reads an
   empty list and nothing is attached (owner 2026-10-15: 选了 PDF 之后是空的;
   the harness never showed it because React computed the update eagerly there). */
export const takePickedFiles = (input: HTMLInputElement): File[] => {
  const picked = Array.from(input.files ?? []);
  input.value = '';
  return picked;
};
