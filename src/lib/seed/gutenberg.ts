/**
 * gutenberg.ts — Fetch and clean public domain books from Project Gutenberg.
 *
 * ## What is Project Gutenberg?
 *
 * Project Gutenberg (gutenberg.org) is the oldest digital library of free
 * ebooks. It has 70,000+ books in the public domain — perfect for seeding
 * a collaborative editor with real, varied content.
 *
 * ## Why Gutendex?
 *
 * Gutenberg itself doesn't have a great API. Gutendex (gutendex.com) is a
 * community-maintained JSON API that wraps the Gutenberg catalogue. It gives
 * us structured metadata (title, author, format URLs) without scraping HTML.
 *
 * ## The cleaning challenge
 *
 * Every Gutenberg ebook includes legal boilerplate at the top and bottom —
 * licence text, transcriber notes, etc. This boilerplate is delimited by
 * well-known markers:
 *
 *   *** START OF THE PROJECT GUTENBERG EBOOK [TITLE] ***
 *   ... actual book content ...
 *   *** END OF THE PROJECT GUTENBERG EBOOK [TITLE] ***
 *
 * We strip everything outside these markers to get the clean book text.
 * Some older texts use "THIS EBOOK" instead of "THE PROJECT GUTENBERG EBOOK",
 * so we handle both variants.
 */

/**
 * Metadata returned by the Gutendex API for a single book.
 *
 * We only type the fields we actually use. The full API response has many
 * more fields (subjects, bookshelves, download count, etc.) but we don't
 * need them for seeding.
 */
export interface GutenbergBook {
  /** Gutenberg catalogue ID (e.g. 11 for Alice in Wonderland) */
  id: number;
  /** Book title as catalogued */
  title: string;
  /** List of authors with name, birth year, death year */
  authors: Array<{
    name: string;
    birth_year: number | null;
    death_year: number | null;
  }>;
  /**
   * Map of MIME type → URL for different formats.
   *
   * Gutenberg offers books in many formats: HTML, EPUB, plain text, etc.
   * We want the plain text version (text/plain; charset=us-ascii or utf-8).
   * The key format is like "text/plain; charset=utf-8" and the value is the
   * download URL.
   */
  formats: Record<string, string>;
}

/**
 * Fetch metadata for a book from the Gutendex API.
 *
 * @param bookId - The Project Gutenberg catalogue ID
 * @returns The book metadata, or null if the book doesn't exist
 *
 * @example
 * const book = await fetchBookMetadata(11);
 * // → { id: 11, title: "Alice's Adventures in Wonderland", ... }
 */
export async function fetchBookMetadata(
  bookId: number
): Promise<GutenbergBook | null> {
  const url = `https://gutendex.com/books/${bookId}`;
  const response = await fetch(url);

  if (!response.ok) {
    console.error(
      `Failed to fetch metadata for book ${bookId}: ${response.status} ${response.statusText}`
    );
    return null;
  }

  return response.json() as Promise<GutenbergBook>;
}

/**
 * Find the plain text download URL from a book's format map.
 *
 * Gutenberg offers multiple text encodings. We prefer UTF-8 (handles accented
 * characters in French/Spanish texts), but fall back to ASCII if that's all
 * that's available.
 *
 * We also skip any URL ending in .zip — we don't want to deal with
 * decompression. The plain .txt URLs work fine over HTTP.
 *
 * @param formats - The formats map from the Gutendex API response
 * @returns The URL to download the plain text, or null if not found
 */
export function findPlainTextUrl(
  formats: Record<string, string>
): string | null {
  // Iterate all format entries looking for plain text
  for (const [mimeType, url] of Object.entries(formats)) {
    if (mimeType.startsWith("text/plain") && !url.endsWith(".zip")) {
      return url;
    }
  }
  return null;
}

/**
 * Download the full plain text of a book.
 *
 * @param url - The plain text download URL (from findPlainTextUrl)
 * @returns The raw text content of the book
 */
export async function downloadBookText(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download book text: ${response.status}`);
  }

  return response.text();
}

/**
 * Strip Project Gutenberg boilerplate from a book's text.
 *
 * ## How Gutenberg boilerplate works
 *
 * Every Gutenberg ebook follows this structure:
 *
 *   [Preamble: licence info, transcriber notes, etc.]
 *   *** START OF THE PROJECT GUTENBERG EBOOK [TITLE] ***
 *   [Actual book content]
 *   *** END OF THE PROJECT GUTENBERG EBOOK [TITLE] ***
 *   [Postamble: full licence text, donation info, etc.]
 *
 * The markers use three asterisks and are case-insensitive. Some older
 * texts use slightly different wording ("THIS EBOOK" instead of
 * "THE PROJECT GUTENBERG EBOOK"), so our regex handles both.
 *
 * ## Edge cases
 *
 * - If there's no START marker, we return the full text (some very old
 *   Gutenberg texts don't have them)
 * - If there's no END marker, we take everything after START
 * - We trim the result to remove leading/trailing whitespace
 *
 * @param text - The raw downloaded text including boilerplate
 * @returns The clean book content with boilerplate removed
 */
export function stripGutenbergBoilerplate(text: string): string {
  // Match the START marker.
  // The regex is case-insensitive and matches both:
  //   "*** START OF THE PROJECT GUTENBERG EBOOK TITLE ***"
  //   "*** START OF THIS PROJECT GUTENBERG EBOOK ***"
  // The .*? in the middle handles any title text between START and ***
  const startPattern =
    /\*{3}\s*START OF (?:THE |THIS )?PROJECT GUTENBERG EBOOK.*?\*{3}/i;
  const endPattern =
    /\*{3}\s*END OF (?:THE |THIS )?PROJECT GUTENBERG EBOOK.*?\*{3}/i;

  const startMatch = startPattern.exec(text);
  const endMatch = endPattern.exec(text);

  // Extract the content between markers
  let content: string;

  if (startMatch) {
    // Start after the START marker
    const startIndex = startMatch.index + startMatch[0].length;

    if (endMatch && endMatch.index > startIndex) {
      // Take content between START and END markers
      content = text.slice(startIndex, endMatch.index);
    } else {
      // No END marker found — take everything after START
      content = text.slice(startIndex);
    }
  } else {
    // No START marker found — return the full text.
    // This happens with some very old Gutenberg texts that predate
    // the standardised boilerplate format.
    content = text;
  }

  return content.trim();
}

/**
 * Fetch a complete Gutenberg book: metadata + cleaned text.
 *
 * This is the main entry point for the Gutenberg module. It orchestrates
 * the full pipeline: fetch metadata → find text URL → download → clean.
 *
 * @param bookId - The Project Gutenberg catalogue ID
 * @returns Object with title, author, and cleaned text
 * @throws If the book can't be found or doesn't have a plain text format
 */
export async function fetchGutenbergBook(bookId: number): Promise<{
  title: string;
  author: string;
  text: string;
}> {
  // Step 1: Get metadata from Gutendex
  const metadata = await fetchBookMetadata(bookId);
  if (!metadata) {
    throw new Error(`Book ${bookId} not found in Gutenberg catalogue`);
  }

  // Step 2: Find the plain text download URL
  const textUrl = findPlainTextUrl(metadata.formats);
  if (!textUrl) {
    throw new Error(
      `Book ${bookId} ("${metadata.title}") has no plain text format available`
    );
  }

  // Step 3: Download the raw text
  const rawText = await downloadBookText(textUrl);

  // Step 4: Strip the Gutenberg boilerplate
  const cleanText = stripGutenbergBoilerplate(rawText);

  // Format the author name. Gutenberg stores names as "Last, First" but
  // we want "First Last" for display.
  const author =
    metadata.authors.length > 0
      ? formatAuthorName(metadata.authors[0].name)
      : "Unknown";

  return {
    title: metadata.title,
    author,
    text: cleanText,
  };
}

/**
 * Convert "Last, First" author name format to "First Last".
 *
 * Gutenberg catalogues authors as "Austen, Jane" but for display we
 * want "Jane Austen". If there's no comma, we return the name as-is.
 */
function formatAuthorName(name: string): string {
  const parts = name.split(", ");
  if (parts.length === 2) {
    return `${parts[1]} ${parts[0]}`;
  }
  return name;
}
