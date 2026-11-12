import { fail } from '../shared/errors';
export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }
export function xmlText(value: string): string {
  return value.replace(/&([^;\s]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:\d+|x[0-9a-f]+)$/i.test(entity)) fail('INVALID_MANIFEST');
    const n = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(n) || n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) fail('INVALID_MANIFEST');
    return String.fromCodePoint(n);
  });
}
/** Bounded non-validating XML subset, usable inside dedicated workers without DOM. No DTD/entities. */
export function parseXml(text: string): XmlNode {
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) fail('MANIFEST_LIMIT');
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) fail('INVALID_MANIFEST');
  const root: XmlNode = { name: '', attrs: Object.create(null), children: [], text: '' }, stack = [root];
  let pos = 0, nodes = 0;
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/(?:[A-Za-z_][\w:.-]*)\s*>|<(?:[A-Za-z_][\w:.-]*)(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/gy;
  while (pos < text.length) {
    pattern.lastIndex = pos; const m = pattern.exec(text); if (!m) fail('INVALID_MANIFEST'); pos = pattern.lastIndex;
    const token = m[0], current = stack.at(-1)!;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { current.text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) { if (stack.length === 1 || current.name !== token.slice(2, -1).trim()) fail('INVALID_MANIFEST'); stack.pop(); continue; }
    if (token.startsWith('<')) {
      const name = /^<([A-Za-z_][\w:.-]*)/.exec(token)![1];
      const attributes = token.slice(name.length + 1, token.endsWith('/>') ? -2 : -1);
      const attrs: Record<string, string> = Object.create(null);
      let consumed = 0; const re = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
      while (consumed < attributes.length) { re.lastIndex = consumed; const a = re.exec(attributes); if (!a) { if (attributes.slice(consumed).trim()) fail('INVALID_MANIFEST'); break; } if (Object.hasOwn(attrs, a[1])) fail('INVALID_MANIFEST'); attrs[a[1]] = xmlText(a[2] ?? a[3]); consumed = re.lastIndex; }
      const child: XmlNode = { name, attrs, children: [], text: '' }; current.children.push(child);
      if (++nodes > 300000 || stack.length > 64) fail('MANIFEST_LIMIT');
      if (!token.endsWith('/>')) stack.push(child);
    } else current.text += xmlText(token);
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim()) fail('INVALID_MANIFEST');
  return root.children[0];
}
export const localName = (node: XmlNode): string => node.name.split(':').at(-1)!;
export const children = (node: XmlNode, name: string): XmlNode[] => node.children.filter(n => localName(n) === name);
export const child = (node: XmlNode, name: string): XmlNode | undefined => children(node, name)[0];
