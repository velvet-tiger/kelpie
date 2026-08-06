/**
 * Driving a controlled input the way a person does.
 *
 * React installs its own `value` setter on the node and tracks the last value it
 * wrote, so a plain `input.value = 'x'` is invisible to it: the change event
 * fires, React compares against what it thinks is there, and drops the update.
 * Calling the prototype's setter is what makes the assignment visible.
 *
 * Here rather than in each suite because this is the third file that needed it,
 * which is the point at which `stubClient` moved too.
 */
export function setInputValue(input: HTMLElement, value: string): void {
  Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')?.set?.call(
    input,
    value,
  )
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
