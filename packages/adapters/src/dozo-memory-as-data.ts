/** A tag that would open or close the block memory is shown to the model in. */
const BLOCK_TAG = /<(\s*\/?\s*durable_memory)/gi;
/** Characters some readers take as a line break where the prompt's own lines do not break. */
const ODD_BREAK = /[\v\f\u0085  ]/g;
/** A line written like the heading the block gives each document ("## bot: MEMORY.md ..."). */
const HEADING = /^([ \t]*)(#{1,6}[ \t]*(?:bot|user)[ \t]*:)/gim;

/**
 * A memory document as data inside the durable memory block: a note (written by hand, by the
 * remember tool or learned) cannot close the block or pass for one of its document headings. A
 * document without any of them is returned as it is.
 */
export function dozoMemoryAsData<T extends { content: string }>(document: T): T {
  const content = document.content
    .replace(ODD_BREAK, "\n")
    .replace(BLOCK_TAG, "&lt;$1")
    .replace(HEADING, "$1\\$2");
  return content === document.content ? document : { ...document, content };
}
