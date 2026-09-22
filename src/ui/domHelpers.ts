/**
 * src/ui/domHelpers.ts — tiny internal DOM-construction helpers shared by
 * every screen module. Not part of contracts/ui.ts; a private implementation
 * detail (00-architecture.md section 11 permits small extra helper files
 * inside a module's own owned directory).
 */

export interface ElOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: ElOptions): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts?.className !== undefined) e.className = opts.className;
  if (opts?.text !== undefined) e.textContent = opts.text;
  if (opts?.attrs !== undefined) {
    for (const key of Object.keys(opts.attrs)) {
      e.setAttribute(key, opts.attrs[key] as string);
    }
  }
  return e;
}

/** A `<button type="button" data-action="...">text</button>`, with optional extra attributes (e.g. data-binding-action). */
export function actionButton(dataAction: string, text: string, extraAttrs?: Record<string, string>): HTMLButtonElement {
  return el('button', {
    text,
    attrs: { type: 'button', 'data-action': dataAction, ...extraAttrs },
  });
}
