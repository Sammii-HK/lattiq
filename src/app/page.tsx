import Link from "next/link";
import { ArrowUpRight, BookOpenText } from "lucide-react";
import { DOCUMENTS } from "@/lib/constants";

const books = DOCUMENTS.filter((doc) => ["the-yellow-wallpaper", "alice-in-wonderland", "pride-and-prejudice"].includes(doc.id));
const workspaces = DOCUMENTS.filter((doc) => !books.includes(doc));
const authors: Record<string, string> = {
  "the-yellow-wallpaper": "Charlotte Perkins Gilman",
  "alice-in-wonderland": "Lewis Carroll",
  "pride-and-prejudice": "Jane Austen",
};

export default function Home() {
  const collaborationConfigured = Boolean(process.env.NEXT_PUBLIC_WS_URL || process.env.NODE_ENV === "development");
  return (
    <div className="lattiq-shell">
      <a className="skip-link" href="#main">Skip to documents</a>
      <header className="lattiq-nav">
        <Link href="/" className="lattiq-wordmark" aria-label="Lattiq home"><span className="lattiq-mark"><BookOpenText size={20} aria-hidden="true" /></span>Lattiq<span className="lattiq-edition">A writing room</span></Link>
        <a href="#library" className="quiet-link">The reading shelf <ArrowUpRight size={16} aria-hidden="true" /></a>
      </header>
      <main id="main">
        <section className="room-intro" aria-labelledby="intro">
          <div>
            <p className="room-eyebrow">A thought is a good place to start.</p>
            <h1 id="intro">Room to think.<br /><em>Space to write.</em></h1>
            <p className="room-deck">A local-first editor for the words you’re working out. Start with a blank page, make a plan, or get lost in a good book.</p>
            <Link className="room-primary" href="/doc/scratch-pad">Open your scratch pad <ArrowUpRight size={16} aria-hidden="true" /></Link>
            <p className="room-mode">{collaborationConfigured ? "Local saving, with collaboration when connected." : "Saved in this browser. No account needed."}</p>
          </div>
          <aside className="room-note" aria-labelledby="note-title">
            <span className="room-eyebrow">A note on where your words live</span>
            <h2 id="note-title">Yours, on this device.</h2>
            <p>Documents are saved in this browser. You can return to them after a reload, even without a connection.</p>
            <p>{collaborationConfigured ? "The editor shows whether your document is connecting, syncing or offline. Offline edits merge when the room connection returns." : "This demo is device-only. There is no collaboration server connected, so your edits are not shared with other visitors."}</p>
            <p className="room-note-small">Browser storage is not a backup. Clearing site data removes local documents.</p>
          </aside>
        </section>
        <section className="room-section" aria-labelledby="workspace-title">
          <div className="room-section-heading"><div><p className="room-eyebrow">01 / Your workspace</p><h2 id="workspace-title">Pick up a page.</h2></div><p>Four places to begin. Edits stay with you.</p></div>
          <div className="workspace-grid">
            {workspaces.map((doc, index) => <Link key={doc.id} href={`/doc/${doc.id}`} className="workspace-link"><span className="workspace-index">0{index + 1}</span><div><h3>{doc.title}</h3><p>{doc.description}</p></div><ArrowUpRight className="workspace-arrow" size={18} aria-hidden="true" /></Link>)}
          </div>
        </section>
        <section id="library" className="room-section reading-shelf" aria-labelledby="shelf-title">
          <div className="room-section-heading"><div><p className="room-eyebrow">02 / The reading shelf</p><h2 id="shelf-title">Good company for a blank page.</h2></div><p>Public-domain books. Read, annotate and try the editor with a longer document.</p></div>
          <div className="book-grid">
            {books.map((doc, index) => <Link key={doc.id} href={`/doc/${doc.id}`} className={`book-link book-link--${index + 1}`}><div className="book-cover"><span className="book-kicker">Lattiq / Reading copy</span><h3>{doc.title}</h3><span className="book-author">{authors[doc.id]}</span><span className="book-open">Open book <ArrowUpRight size={16} aria-hidden="true" /></span></div><p>{doc.description}</p></Link>)}
          </div>
        </section>
      </main>
      <footer className="room-footer"><p>Lattiq <span aria-hidden="true">/</span> Built for words, and the work behind them.</p><a href="https://sammii.dev/projects/lattiq/">How it’s built <ArrowUpRight size={16} aria-hidden="true" /></a></footer>
    </div>
  );
}
