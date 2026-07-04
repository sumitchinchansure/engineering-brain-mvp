/**
 * Normalizes an entity name so "Auth Service", "`auth-service`" and
 * "auth services" dedupe to the same canonical key. Deliberately simple:
 * exact matching handles most duplicates; the ambiguous remainder goes to
 * the LLM judge in the linking stage.
 */
export function canonicalizeName(name: string): string {
  let s = name.trim().toLowerCase();
  s = s.replace(/^[`'"]+|[`'"]+$/g, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[.,;:!?]+$/g, '');
  const words = s.split(' ');
  const last = words[words.length - 1];
  // Singularize a trailing plural "s", but leave -is/-ss/-us/-os endings
  // alone ("redis", "class", "status", "chaos" are not plurals).
  const notPlural = /(?:is|ss|us|os)$/.test(last);
  if (last.length > 3 && last.endsWith('s') && !notPlural) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(' ').trim();
}
