// Preserve keyboard position only when a render actually replaced its control.
// Stable card + control identities prevent moving focus to another job's action.
export function preserveFocus(root: HTMLElement, fallback?: HTMLElement): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return () => {};
  const card = active.closest<HTMLElement>('[data-job-id], [data-candidate-id]');
  const jobId = card?.dataset.jobId, candidateId = card?.dataset.candidateId;
  const scope = card ?? root;
  const name = active.getAttribute('name'), key = active.dataset.focusKey;
  const matches = (element: HTMLElement): boolean => name !== null ? element.getAttribute('name') === name : key !== undefined && element.dataset.focusKey === key;
  const index = Array.from(scope.querySelectorAll<HTMLElement>('input, select, textarea, button')).filter(matches).indexOf(active);
  const start = active instanceof HTMLInputElement ? active.selectionStart : null;
  const end = active instanceof HTMLInputElement ? active.selectionEnd : null;
  return () => {
    if (active.isConnected) return;
    // Do not steal focus if the user moved elsewhere during an async render.
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    const nextScope = jobId || candidateId ? Array.from(root.querySelectorAll<HTMLElement>('[data-job-id], [data-candidate-id]')).find(element => jobId ? element.dataset.jobId === jobId : element.dataset.candidateId === candidateId) : root;
    const replacement = nextScope && Array.from(nextScope.querySelectorAll<HTMLElement>('input, select, textarea, button')).filter(matches)[index];
    const target = replacement && !replacement.matches(':disabled') ? replacement : fallback;
    target?.focus();
    if (target instanceof HTMLInputElement && start !== null && end !== null) target.setSelectionRange(start, end);
  };
}
