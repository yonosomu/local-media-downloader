// Only UI form values live here. Sources and jobs remain coordinator-owned.
export interface FormDraft { [name: string]: { value: string; checked: boolean } }
export function captureDraft(root: HTMLElement): FormDraft {
  const draft: FormDraft = Object.create(null) as FormDraft;
  for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
    draft[input.name] = { value: input.value, checked: input instanceof HTMLInputElement && input.checked };
  }
  return draft;
}
export function restoreDraft(root: HTMLElement, draft: FormDraft, names?: string[]): void {
  for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
    const saved = draft[input.name];
    if (!saved || names && !names.includes(input.name)) continue;
    // A vanished track/container must not leave a select with a forged value.
    if (input instanceof HTMLSelectElement && !Array.from(input.options).some(o => o.value === saved.value)) continue;
    input.value = saved.value;
    if (input instanceof HTMLInputElement) input.checked = saved.checked;
  }
}
