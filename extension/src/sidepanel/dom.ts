/**
 * Tiny DOM builder for the side panel.
 *
 * Mirrors `ui/shadow.ts#el` so both surfaces build nodes the same way. Reusing
 * that module directly would pull WXT's content-script runtime into the panel
 * bundle for the sake of fifteen lines.
 */

type Attrs = Record<string, string | number | boolean | null | undefined>;

export interface ElementSpec {
  readonly tag: string;
  readonly class?: string;
  readonly text?: string;
  readonly attrs?: Attrs;
  readonly children?: readonly (Node | string)[];
}

export function el(spec: ElementSpec): HTMLElement {
  const node = document.createElement(spec.tag);
  if (spec.class) node.className = spec.class;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.attrs) {
    for (const [key, value] of Object.entries(spec.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of spec.children ?? []) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Remove every child, without touching innerHTML. */
export function clear(node: Element): void {
  node.replaceChildren();
}

/** A labelled form row. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id;
  const labelNode = el({ tag: "label", class: "field-label", text: label });
  if (id) labelNode.setAttribute("for", id);
  const row = el({ tag: "div", class: "field" });
  row.appendChild(labelNode);
  row.appendChild(control);
  if (hint) row.appendChild(el({ tag: "p", class: "hint", text: hint }));
  return row;
}
