/**
 * parse-text.ts: turn plain Gutenberg text into a flat list of blocks.
 *
 * The blocks are fed to a headless Lexical editor by scripts/build-seeds.ts,
 * which lets Lexical's own Yjs binding write the CRDT structure. An earlier
 * version hand-built the Y.XmlText tree here, but it skipped the Y.Map that
 * Lexical embeds for every TextNode, so the result was not a document the
 * CollaborationPlugin could round-trip.
 */

// ── Text parsing types ─────────────────────────────────────────────

/**
 * Represents a block of content in the parsed text.
 *
 * We parse plain text into a flat list of blocks. Each block is either
 * a paragraph or a heading, determined by heuristic analysis of the text.
 */
export interface TextBlock {
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
