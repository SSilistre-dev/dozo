/** Characters some readers take as a line break where the prompt's own lines do not break. */
const ODD_BREAK = /[\v\f\u0085\u2028\u2029]/g;
/** A line written like the heading the block gives each document ("## Your memory: MEMORY.md ..."). */
const HEADING = /^([ \t]*)(#{1,6}[ \t]*(?:your memory|shared memory)[ \t]*:)/gim;

/**
 * A memory document as data inside the durable memory block: a note (written by hand, by the
 * remember tool or learned) cannot pass for one of its document headings. Closing the block is
 * upstream's own escaping of `<` in the prompt builder (dozo-memory-as-data.test.ts holds it). A
 * document without any of them is returned as it is.
 */
export function dozoMemoryAsData<T extends { content: string }>(document: T): T {
  const content = document.content
    .replace(ODD_BREAK, "\n")
    .replace(HEADING, "$1\\$2");
  return content === document.content ? document : { ...document, content };
}
