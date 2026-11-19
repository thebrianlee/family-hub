// A book search result's cover, as the browser loads it: always through the
// hub (src/app/api/books/thumb), never from the book site itself, so the
// browser contacts no outside host and the Reading module gate covers it.
// Client-safe.

export function coverPreviewSrc(thumbnail: string): string {
  return `/api/books/thumb?url=${encodeURIComponent(thumbnail)}`;
}
