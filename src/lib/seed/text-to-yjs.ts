/**
 * text-to-yjs.ts — Convert plain text into a Y.Doc that Lexical can render.
 *
 * ## The challenge
 *
 * We have plain text (from Gutenberg) and need to produce a Y.Doc that,
 * when loaded by Lexical's CollaborationPlugin, renders as a properly
 * structured rich text document with headings and paragraphs.
 *
 * ## How Lexical stores content in Yjs (V1 binding)
 *
 * This is the key insight from reading @lexical/yjs source code. Lexical's
 * V1 collaboration binding uses a specific Yjs structure:
 *
 * 1. **Root**: The document root is a Y.XmlText registered as `doc.get('root', Y.XmlText)`.
 *    This is NOT a Y.XmlElement — it's a Y.XmlText that acts as a container.
 *
 * 2. **Element nodes** (paragraphs, headings): Each is a child Y.XmlText
 *    embedded within the parent XmlText's delta. The node type is stored
 *    as an XML attribute `__type` on the XmlText (e.g. `__type: "paragraph"`
 *    or `__type: "heading"`).
 *
 * 3. **Text content**: Plain text strings are inserted directly into the
 *    element's XmlText. Lexical reads the delta of each element XmlText
 *    and creates CollabTextNode / CollabElementNode children from it.
 *
 * 4. **Properties**: Node properties like heading `__tag` (h1, h2, etc.)
 *    are stored as XML attributes on the XmlText.
 *
 * ## How we build the document
 *
 * For each paragraph or heading in the source text:
 *   1. Create a new Y.XmlText
 *   2. Set its `__type` attribute to "paragraph" or "heading"
 *   3. If it's a heading, set the `__tag` attribute (e.g. "h2")
 *   4. Insert the text content into the XmlText
 *   5. Insert the XmlText into the root XmlText
 *
 * All mutations happen inside a single Y.Doc transaction so they're
 * captured as one atomic Yjs update — important for persistence.
 *
 * ## Why we need to match Lexical's internal structure exactly
 *
 * When CollaborationPlugin loads a Y.Doc, it calls `doc.get('root', XmlText)`
 * and then reads the delta of that root XmlText. Each embedded XmlText in
 * the delta becomes a CollabElementNode. The `__type` attribute tells Lexical
 * which node class to instantiate (ParagraphNode, HeadingNode, etc.).
 *
 * If our structure doesn't match exactly, Lexical will either:
 *   - Crash with "Node X is not registered"
 *   - Render an empty document
 *   - Corrupt the CRDT state
 *
 * We verified this by reading the createBinding() function in LexicalYjs.dev.mjs
 * (line 830): `const rootXmlText = doc.get('root', XmlText);`
 */

import * as Y from "yjs";

// ── Text parsing types ─────────────────────────────────────────────

/**
 * Represents a block of content in the parsed text.
 *
 * We parse plain text into a flat list of blocks. Each block is either
 * a paragraph or a heading, determined by heuristic analysis of the text.
 */
interface TextBlock {
  /** The type of block — maps directly to Lexical node types */
  type: "paragraph" | "heading";
  /** The text content of this block */
  content: string;
  /**
   * For headings: the HTML tag (h1-h6).
   *
   * We use h1 for "CHAPTER" lines and h2 for other all-caps headings.
   * This gives a reasonable document hierarchy for navigation.
   */
  tag?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
}

// ── Heading detection ──────────────────────────────────────────────

/**
 * Chapter heading patterns.
 *
 * We look for lines that are clearly chapter headings. Books use various
 * formats:
 *   - "CHAPTER I" / "CHAPTER 1" / "CHAPTER I." / "CHAPTER XII"
 *   - "Chapter I" / "Chapter 1" (title case)
 *   - "CHAPTER I. The Beginning" (chapter with title)
 *
 * These get h1 tags — they're the primary document structure.
 */
const CHAPTER_PATTERN = /^chapter\s+[ivxlcdm\d]+\.?\s*/i;

/**
 * Detect whether a line of text is a heading.
 *
 * Our heuristic for headings in plain text:
 *
 * 1. **Chapter headings**: Lines matching "CHAPTER [number]" patterns → h1
 * 2. **Short all-caps lines**: Lines that are:
 *    - Entirely uppercase letters, numbers, spaces, and punctuation
 *    - Fewer than 80 characters (long all-caps text is likely a paragraph
 *      from an older text, not a heading)
 *    - At least 2 characters (single letters aren't headings)
 *    → h2
 *
 * This is necessarily imperfect — plain text doesn't have semantic markup.
 * But it works well enough for Gutenberg books, which tend to use very
 * consistent formatting conventions.
 *
 * @param line - A single line of trimmed text
 * @returns The heading tag if it's a heading, or null if it's a paragraph
 */
function detectHeading(
  line: string
): "h1" | "h2" | null {
  // Chapter headings are the strongest signal
  if (CHAPTER_PATTERN.test(line)) {
    return "h1";
  }

  // Short all-caps lines are likely section headings or titles.
  // We check that:
  //   - The line has at least 2 characters (skip single letters)
  //   - The line is under 80 characters (skip paragraphs in old all-caps texts)
  //   - The line is entirely uppercase (after removing non-letter characters)
  //
  // The regex [^A-Za-z] strips everything except letters, so we can check
  // if what remains is all uppercase. This handles lines like:
  //   "PART I."  →  "PARTI"  →  all uppercase  →  heading
  //   "ACT III, SCENE 2"  →  "ACTIIISCENE"  →  all uppercase  →  heading
  if (line.length >= 2 && line.length < 80) {
    const lettersOnly = line.replace(/[^A-Za-z]/g, "");
    if (lettersOnly.length >= 2 && lettersOnly === lettersOnly.toUpperCase()) {
      return "h2";
    }
  }

  return null;
}

// ── Text parsing ───────────────────────────────────────────────────

/**
 * Parse plain text into a list of structured blocks.
 *
 * ## Algorithm
 *
 * 1. Split the text on double newlines (blank lines separate paragraphs)
 * 2. For each chunk:
 *    a. Trim whitespace
 *    b. Skip empty chunks
 *    c. Collapse internal newlines to spaces (a paragraph in a book often
 *       wraps at 72 characters, so "line1\nline2" should become "line1 line2")
 *    d. Check if it's a heading (using our heuristic)
 *    e. Create the appropriate block type
 *
 * ## Why collapse internal newlines?
 *
 * Gutenberg plain text files wrap lines at ~72 characters. A single paragraph
 * looks like:
 *
 *   ```
 *   Alice was beginning to get very tired of sitting by her sister on the
 *   bank, and of having nothing to do: once or twice she had peeped into
 *   the book her sister was reading, but it had no pictures or conversations
 *   in it, "and what is the use of a book," thought Alice, "without pictures
 *   or conversations?"
 *   ```
 *
 * That's one paragraph with hard line breaks. We join these into a single
 * flowing paragraph for the editor. Paragraphs are separated by blank lines
 * (double newlines), which is the split point.
 *
 * @param text - The full cleaned book text
 * @returns Array of TextBlocks ready for Yjs conversion
 */
export function parseTextToBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];

  // Split on one or more blank lines.
  // \n\n matches a blank line. We use \n\s*\n to also catch lines that
  // have only whitespace (common in Gutenberg texts).
  const chunks = text.split(/\n\s*\n/);

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    // Collapse internal line breaks to spaces.
    // Replace sequences of whitespace (including newlines) with a single space.
    // This unwraps the hard-wrapped Gutenberg lines into flowing text.
    const content = trimmed.replace(/\s+/g, " ");

    // Check if this block looks like a heading
    const headingTag = detectHeading(content);

    if (headingTag) {
      blocks.push({
        type: "heading",
        content,
        tag: headingTag,
      });
    } else {
      blocks.push({
        type: "paragraph",
        content,
      });
    }
  }

  return blocks;
}

// ── Y.Doc construction ─────────────────────────────────────────────

/**
 * Convert an array of text blocks into a Y.Doc structured for Lexical.
 *
 * ## How Lexical's V1 Yjs binding works (from reading the source)
 *
 * The binding (in createBinding, LexicalYjs.dev.mjs line 826-838) does:
 *
 *   ```js
 *   const rootXmlText = doc.get('root', XmlText);
 *   const root = $createCollabElementNode(rootXmlText, null, 'root');
 *   ```
 *
 * So the root is a Y.XmlText shared type named 'root'. Element nodes
 * (paragraphs, headings) are child Y.XmlText instances embedded in
 * the root's delta. Each child XmlText has:
 *   - A `__type` XML attribute (e.g. "paragraph", "heading")
 *   - Additional attributes for node properties (e.g. `__tag` for headings)
 *   - The text content inserted directly as a string
 *
 * When CollaborationPlugin reads the root's delta, it sees:
 *   [
 *     { insert: XmlText<__type="heading", __tag="h1"> },  ← heading node
 *     { insert: XmlText<__type="paragraph"> },             ← paragraph node
 *     ...
 *   ]
 *
 * Each XmlText's own delta contains the text:
 *   [
 *     { insert: "Chapter I" }
 *   ]
 *
 * ## Why transact()?
 *
 * All mutations are wrapped in doc.transact() so they're captured as a
 * single Yjs update. This matters for persistence — when we call
 * Y.encodeStateAsUpdate(doc), we get one compact binary blob instead of
 * many small ones. It's also faster because Yjs only computes the
 * document state once at the end of the transaction.
 *
 * @param blocks - The parsed text blocks
 * @returns A Y.Doc ready to be persisted and loaded by Lexical
 */
export function blocksToYDoc(blocks: TextBlock[]): Y.Doc {
  const doc = new Y.Doc();

  // Get the root XmlText — this is what Lexical's createBinding() looks for.
  // The key MUST be 'root' to match the binding code:
  //   `doc.get('root', XmlText)`
  const root = doc.get("root", Y.XmlText);

  // Wrap all mutations in a transaction for atomicity and performance.
  doc.transact(() => {
    for (const block of blocks) {
      // Create a new XmlText for this element node.
      // In Lexical's V1 binding, every element node (paragraph, heading, etc.)
      // is represented as a Y.XmlText, NOT a Y.XmlElement. This is counter-
      // intuitive but it's how the binding works — text content and formatting
      // are stored as XmlText deltas, and the node type is an XML attribute.
      const elementXmlText = new Y.XmlText();

      // Set the node type. Lexical uses the `__type` attribute to determine
      // which LexicalNode class to instantiate when syncing from Yjs.
      // "paragraph" → ParagraphNode, "heading" → HeadingNode, etc.
      elementXmlText.setAttribute("__type", block.type);

      // For headings, set the tag attribute. HeadingNode stores its level
      // (h1-h6) in the `__tag` property, which maps to the `__tag` XML
      // attribute in the Yjs shared type.
      if (block.type === "heading" && block.tag) {
        elementXmlText.setAttribute("__tag", block.tag);
      }

      // Insert the text content into the element's XmlText.
      // This becomes a { insert: "text content" } entry in the XmlText's
      // delta, which Lexical reads and creates a CollabTextNode from.
      if (block.content) {
        elementXmlText.insert(0, block.content);
      }

      // Embed this element XmlText into the root XmlText.
      // This uses insertEmbed, which creates an { insert: XmlText } entry
      // in the root's delta. Lexical iterates these entries and creates
      // a CollabElementNode for each embedded XmlText.
      //
      // We insert at root.length to append to the end — building the
      // document top to bottom.
      root.insertEmbed(root.length, elementXmlText);
    }
  });

  return doc;
}

/**
 * Convert plain text directly into a Y.Doc.
 *
 * This is the main entry point — a convenience function that combines
 * parsing and Yjs construction.
 *
 * @param text - Plain text content (e.g. from a Gutenberg book)
 * @returns A Y.Doc structured for Lexical's CollaborationPlugin
 *
 * @example
 * const doc = textToYDoc("CHAPTER I\n\nIt was a dark and stormy night.");
 * const update = Y.encodeStateAsUpdate(doc);
 * fs.writeFileSync("book.yjs", update);
 */
export function textToYDoc(text: string): Y.Doc {
  const blocks = parseTextToBlocks(text);
  return blocksToYDoc(blocks);
}
